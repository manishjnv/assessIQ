# RCA / incident log

> Append-only. One entry per resolved bug or incident.
> Read at Phase 0; recurring patterns become Phase 3 critique guardrails.
> Format reference: see `CLAUDE.md` § RCA / incident log.

## 2026-05-25 — Cloned-pack questions had no question_versions → excluded from the attempt pool

**Symptom:** A candidate could not start an attempt on an assessment built from a licensed/cloned platform set — the active-question pool came back empty (or short of the required count, failing the publish pre-flight). Latent: never observed in prod because cloned-pack assessments had not run end-to-end (licensed pickers empty / platform packs still draft).
**Cause:** `clonePackToTenant` (`modules/04-question-bank/src/clone.ts`) inserted each cloned question with `version=1` but wrote NO `question_versions` row. The attempt-start pool query `listActiveQuestionPoolForPick` (`modules/06-attempt-engine/src/repository.ts:673`) INNER-JOINs `question_versions` (to pin each question to `MAX(qv.version)`), so any `status='active'` question with no snapshot is silently dropped from the pool. Cloned questions — created "published" directly without going through `publishPack` (which is what normally writes the v1 snapshot + bumps version to 2) — never got one.
**Fix:** `clone.ts` now writes a `question_versions` row at version=1 per cloned question and inserts the question at `version=2`, exactly matching publishPack's end-state (`questions.version = MAX(qv.version)+1`). Migration `0095_backfill_clone_question_versions.sql` backfills the snapshot + restores `version` for pre-existing clone questions (idempotent `NOT EXISTS` guard; scoped to `question_packs.source_pack_id IS NOT NULL`). Discovered while building B3 (licensed-set re-sync), which depends on a coherent clone version model.
**Prevention:** the B3 re-sync engine (`resyncClonedPack`) maintains the same invariant on every add/version-bump; codex:rescue gated the clone engine and verified the version arithmetic + in-flight-attempt safety (REVISE→ACCEPT). No automated e2e test yet — cloned-pack attempt start needs Docker/testcontainers; behavioral verification is operator-pending.

## 2026-05-24 — Generation History help provider was inert (hyphenated page prefix could never match a valid key)

**Symptom:** Found while adding scorecard help, not in production. The Generation
History page (`modules/10-admin-dashboard/src/pages/generation-attempts.tsx`)
mounted a `HelpProvider` via `AdminShell helpPage="admin.generation-attempts.history"`,
and its `<h1>` carried `data-help-id="admin.generation_attempts.history"` — yet no
help could ever render on the page. No user-visible breakage (nothing on the page
actually called `useHelp`), but any future `HelpTip` added under that prefix would
have silently degraded to no-tooltip.

**Cause:** two independent dead ends. (1) The provider `page` prop was **hyphenated**
(`admin.generation-attempts.history`), but help is fetched via
`listHelpForPage` → `WHERE key LIKE page || '.%'` and `help_id` segments are
validated `[a-z0-9_]` only (no hyphens) by both `isValidHelpId` and
`admin-help-keys.test.ts`. A hyphenated prefix therefore can never match any
seeded key. (2) The `<h1 data-help-id=…>` attribute is inert — this app has **no
global `[data-help-id]` binder**; help renders only through `<HelpTip>`/`useHelp`
(same finding as RCA 2026-05-19). So even the one "wired" key was decorative.

**Fix:** changed the page prop to `helpPage="admin.gen_score"` (hyphen-free) and
wired four real `<HelpTip>`s on the scorecard (`admin.gen_score.{score_button,
verdict,structural,runtime}`), seeded in `admin.yml` + forward migration `0089`.
The orphaned `admin.generation_attempts.history` YAML key is left in place (a kept
test asserts its presence); the `<h1>` was not converted (out of scope).

**Prevention:** Phase-3 help-wiring checklist — a `HelpProvider page=` value must
be hyphen-free and be a true dot-prefix of every `helpId` used on that page
(`key LIKE page||'.%'`), and a `data-help-id` attribute alone renders nothing
(use `<HelpTip>`/`useHelp`). Recurring theme with RCA 2026-05-19 (help key/prefix
mismatch degrades silently). A lint that cross-checks each page's `helpPage`
prefix against the `HelpTip helpId`s in the same file would catch this class.

## 2026-05-24 — analytics:refresh_mv failed every minute — MV owned by a role the worker can't refresh as

**Symptom:** `assessiq-worker` logged the `analytics:refresh_mv` cron FAILED **every minute** — `must be owner of materialized view attempt_summary_mv` (PG SQLSTATE 42501) — flooding `worker.log` (66MB). `attempt_summary_mv` has held **stale data since it was created** (migration 0060); analytics reports read a never-refreshed snapshot.

**Cause:** `0060_attempt_summary_mv.sql` created the MV as the migration role (`assessiq`, a BYPASSRLS superuser), which became the owner. The refresh job runs in the worker, which connects as the unprivileged app role `assessiq_app` (RLS-subject — tenant isolation depends on it staying that way). `REFRESH MATERIALIZED VIEW` requires the executing role to **be** the owner — being a *member* of the owner role is not enough (confirmed: `assessiq_app` ∈ `assessiq_system` yet refresh still denied). Compounding it: the MV's SELECT reads the RLS-subject base tables (`attempt_scores`/`attempts`/`assessments`) across ALL tenants, so the refresh must run as a BYPASSRLS role or the MV would refresh to empty.

**Fix:** (commit `<sha>`) (1) migration `0088_attempt_summary_mv_owner.sql` — `ALTER MATERIALIZED VIEW attempt_summary_mv OWNER TO assessiq_system` (the designated BYPASSRLS role). (2) `modules/15-analytics/src/refresh-mv-job.ts` — the worker (`assessiq_app`, a member of `assessiq_system`) does `SET ROLE assessiq_system` around the refresh, with `RESET ROLE` in `finally` and `client.release(true)` (destroy the connection) if RESET ever fails — so a connection elevated to BYPASSRLS can NEVER return to the pool where a later tenant-scoped query would inherit it (cross-tenant-leak guard). Granting `assessiq_app` BYPASSRLS directly was rejected — it would defeat tenant isolation for every app query. codex:rescue: **ACCEPT** (no pool-contamination path; `release(true)` is the correct destroy API; transaction-scoped `SET LOCAL ROLE` noted as optional future hardening).

**Prevention:** Migration 0088 makes ownership correct for fresh DBs too (0060 creates as the migration superuser; 0088 transfers). Durable rule: **a materialized view refreshed by a background job must be OWNED BY the (BYPASSRLS) role the job assumes — not the migration superuser; and any background `SET ROLE` to a BYPASSRLS role must RESET-or-destroy the pooled connection.** MV consumers still filter by `tenant_id` (`tools/lint-mv-tenant-filter.ts`) — RLS does not cover MVs.

## 2026-05-24 — AI question generation produced 0 questions every run (MCP schema-drift rejection loop; prior "turns + rate-limit" diagnosis was incomplete)

**Symptom:** Every admin **Generate Questions** run finished `failed` with `0/N` saved, `MODEL —`, `CHUNKS 1-0` in AI Generation History. `generation_attempts`: `error_code=AIG_RUNTIME_FAILURE`, message "claude subprocess exited with code 1 (skill=generate-questions)". Last success was 2026-05-17 (count=1); every count≥3 run since failed. (`MODEL —`/`CHUNKS 1-0` are display artifacts of the failure-finalize path not recording `model`/`chunks_failed` — symptoms, not the bug.)

**Cause:** The `generate-*` skills emit `content` with non-canonical field names/shapes — `stem`→`question`, MCQ `options` as objects, `log_lines`/`log_snippet`→`log_excerpt`, prose for the `log_format` enum, `answer`/`correct_answer`→`correct`. The MCP `submit_questions` tool validates the **whole batch** against a `.strict()` Zod schema and returns `isError` on any mismatch (`/var/log/assessiq/mcp-rejections.log` — 9 rejections on 2026-05-24 alone). The model retried ~4× (each rejected → `tool_use:4`/`tool_result:4`), exhausted its turn budget, and `claude` exited 1 → the runtime threw → 0 inserted. count=1 succeeded because one question can clear strict validation; count≥3 fails because one bad field rejects the entire array (P(all-correct) collapses).

The prior handoff (commit `31f83ec`) read `tool_use:4` + `rate_limit_event:1` + `exitCode:1` as "omnibus exhausted `--max-turns 4` + hit a Max-plan rate limit" and prescribed only the sharded-mode flip. That diagnosis is **incomplete**: the 4 tool calls are 4 *rejected* submit attempts (not turn-budget exploration), and `rate_limit_event:1` is an incidental status event. The sharded flip alone does **not** fix it — per-type calls hit the same strict MCP gate. Three prior rounds of `SKILL.md` prompt hardening (FORBIDDEN lists, anti-examples, inline CORRECT-SHAPE examples) also failed because the model invents *novel* wrong shapes.

**Fix:** (code commit `56a664d`) A deterministic tolerant-coercion layer ("be liberal in what you accept") applied BEFORE Zod at **both** validation gates: `tools/assessiq-mcp/src/tools/coerce-questions.ts` (MCP gate → subprocess now exits 0) and an identical `modules/07-ai-grading/src/coerce-question-content.ts` (runtime → canonical content persisted, since the runtime reads the model's raw `parseToolInput`, not the MCP's coerced result). It maps known variants → canonical shape; it never invents content. The MCQ answer key is **fail-closed** (`resolveCorrectIndex`): any ambiguous, conflicting, or present-but-unresolvable answer signal drops `correct` so strict Zod rejects rather than storing a guessed key. The runtime independently re-validates per-type content (`selectValidContent`) and drops invalid questions — defence-in-depth, so it never persists content the MCP would reject. Stopgap also applied: platform tenant flipped to `ai_generate_mode='sharded'` for per-type isolation. codex:rescue: **ACCEPT** (after 2 revise rounds hardening the answer-key resolver).

**Prevention:** The strict Zod schema stays the canonical contract, but coercion absorbs the model's stable output drift instead of the prompt fighting it (3 prompt rounds proved that loses). `tools/assessiq-mcp/src/__tests__/submit-questions.test.ts` (41 tests) pins the coercion + every fail-closed answer-key case. Durable rule: **structured LLM output feeding a strict gate needs a coercion adapter, not endless prompt tightening; and never silently coerce a security-critical value (the answer key) — fail closed on any ambiguity.**

## 2026-05-24 — Platform email sent from a personal Gmail (sender leak + contact-form self-dedup)

**Symptom:** All transactional email (login OTPs, invites) — and the new contact-form enquiries — were sent **From `manishjnvk@gmail.com`** via Gmail SMTP. Contact enquiries (which route `connect@assessiq.in` → Cloudflare Email Routing → `manishjnvk@gmail.com`) were **deduped out of the Inbox** by Gmail because sender == recipient; they appeared "missing" (surfaced by a Cloudflare "missing email" notice). Personal address also leaked as the sender of every OTP/invite.
**Cause:** `/srv/assessiq/.env` had `EMAIL_FROM="AssessIQ <manishjnvk@gmail.com>"` and `SMTP_URL` → `smtp.gmail.com` (personal app-password), despite `modules/13-notifications/SKILL.md` documenting Resend as the default. Gmail SMTP forces the From to the authenticated account, so `EMAIL_FROM` could not be corrected without swapping the transport. Flagged in the 2026-05-21 email audit; unresolved until now.
**Fix:** Verified `assessiq.in` in Resend (DKIM `resend._domainkey` + SPF/MX on `send.assessiq.in` via Cloudflare). Switched `/srv/assessiq/.env`: `SMTP_URL=smtps://resend:<key>@smtp.resend.com:465`, `EMAIL_FROM="AssessIQ <noreply@assessiq.in>"`. Recreated `assessiq-api` + `assessiq-worker` (2026-05-24). Verified end-to-end: contact enquiry + login OTP both deliver to the Inbox From `noreply@assessiq.in`. `.env.bak.<ts>` kept for rollback. See `docs/06-deployment.md` § "Platform email sender → Resend".
**Prevention:** Manual discipline — `.env` is gitignored, so the live sender is now documented in `docs/06-deployment.md`. Candidate guard: a startup assertion that `EMAIL_FROM`'s domain is a verified sending domain (reject `gmail.com`/personal) would catch a regression at boot.

## 2026-05-23 — Duplicate question-set clones possible under concurrent clone-on-use (caught pre-deploy)

**Symptom:** Caught in the Step-2 adversarial review (Sonnet), NOT in production. Concurrent `POST /api/admin/assessments/from-set` for the same `(tenant, source platform pack)` could each create a separate cloned pack in the company tenant — duplicating the set. Blast radius is the tenant's OWN data (no cross-tenant leak / no authz bypass), but it's a correctness/accounting defect.

**Cause:** `materializeSetForTenant` (`modules/04-question-bank/src/clone.ts`) did a "does a clone of source S exist for this tenant?" idempotency `SELECT` then `INSERT`, with no serializing lock and no DB uniqueness constraint on `question_packs(tenant_id, source_pack_id)`. Two concurrent transactions both observe "no clone" and both insert — the classic check-then-act race.

**Fix:** (commit `6a9b2a6`, before the backend deployed) (1) migration `0085_pack_clone_uniqueness.sql` — partial `UNIQUE INDEX question_packs_tenant_source_uniq ON question_packs (tenant_id, source_pack_id) WHERE source_pack_id IS NOT NULL` (replaces the non-unique `question_packs_source_idx` from `0084`); (2) `pg_advisory_xact_lock(hashtext(tenant), hashtext(source))` at the top of the clone transaction in `materializeSetForTenant`, so the second caller waits for the first to commit, then its idempotency `SELECT` finds the clone and returns early. The unique index is the structural backstop for any unlocked path.

**Prevention:** Any "find-or-create then insert" under concurrency needs a serializing lock AND/OR a unique constraint — not the `SELECT` alone. Adversarial review of every cross-tenant *write* path before deploy is the guardrail that caught this. Test owed (Phase 6): parallel `from-set` for one `(tenant, source)` must yield exactly one clone.

## 2026-05-22 — Super-admin generate screen showed almost no domains (platform tenant never seeded)

**Symptom:** After question generation moved to super-admin-only scope (Phase B1), the SA generate screen (`generate-wizard`) listed only **1** domain ("SOC") instead of the 9 defaults every company tenant shows. User reported "nothing shows."

**Cause:** `domains`/`categories` are tenant-scoped (RLS, `tenant_id = current_setting('app.current_tenant', true)::uuid`). The 9 defaults are seeded **per-tenant** by `0019_seed_domains_categories.sql` via `SELECT t.id FROM tenants t`. The super admin operates inside the **"platform" tenant** (`slug='platform'`), which is bootstrapped **by hand after migrations run** (`README` step 5: "direct SQL — no script exists yet"), so it was never part of 0019's fan-out. `seedTenantTaxonomy()` (`modules/04-question-bank/src/seed.ts`) explicitly forbids seeding the platform tenant, so per-company onboarding never backfilled it either. The lone "soc" row on the platform tenant was hand-created via the inline-create UI (0 categories; the tenant had 0 packs). `GET /api/admin/domains` runs `withTenant(session.tenantId)` = platform → RLS returns that 1 row. Proven live: platform tenant `domain_count=1` vs 9/9/9/11 on company tenants.

**Fix:** `0083_seed_platform_tenant_taxonomy.sql` seeds the 9 domains + 56 categories into the platform tenant, **matched by `slug='platform'`** (so `SELECT` returns 0 rows → harmless no-op on a fresh DB where the platform tenant isn't bootstrapped yet), with the **post-0020 `supported_types` baked into each category insert** (0020 already ran and never touched the not-yet-existing platform rows). Idempotent `ON CONFLICT … DO NOTHING` — preserved the hand-made `soc` domain, added 8 domains + 56 categories (64 inserts, 1 skip). Applied via `psql -U assessiq` superuser (bypasses the RLS `WITH CHECK`) + recorded in `schema_migrations` (sha256 `ac65047f…`). No image rebuild (pure data). Verified live: platform tenant **1→9** domains, category counts 9/7/6/6/6/6/6/5/5, `supported_types` exact parity with 0020; company tenants unchanged. Commit `b9d3c57`.

**Prevention:** The platform tenant is now the canonical master question library (`docs/02-data-model.md` § Question bank). Recurring theme: per-tenant seed fan-outs (`SELECT FROM tenants`) silently miss tenants created **after** the migration runs — same class as the 2026-05-17 "new-tenant taxonomy gap" (obs 3063). A startup assertion that the platform tenant carries the full taxonomy would catch a regression; manual discipline otherwise. **NOT fixed here:** the cross-tenant *content*-sharing path — billing entitlements grant a publish *permission flag*, not read access to platform-tenant questions; making a granted set actually usable by a company is deferred to Phase 2.

## 2026-05-22 — Domain switch to assessiq.in: origin-verify rule created as Response (not Request) header → 429 on all auth routes + secret leak

**Symptom:** After cutting the canonical host to `assessiq.in` (Caddy serving + AOP + `.env` flipped), every rate-limited route on the NEW domain returned `429 {"error":{"code":"RATE_LIMITED","message":"missing client IP for rate limit"}}` — Google SSO start, candidate `/take/start`, admin login. The OLD `assessiq.automateedge.cloud` host (still serving then) worked fine. `/api/health` on assessiq.in returned 200 (it isn't rate-limited), which masked the problem. Side symptom: Chrome showed a "Dangerous site" Safe Browsing warning on `assessiq.in/admin/login`.

**Cause:** The `x-origin-verify` Cloudflare Transform Rule on the new `assessiq.in` zone was created under **Modify _Response_ Header** instead of **Modify _Request_ Header**. CF attached `x-origin-verify` to the *response* to the browser, never to the *request* forwarded to the origin. The app reads it off the request — `modules/01-auth/src/middleware/rate-limit.ts:87` (`ORIGIN_TRUST_MODE==="enforce" && !isOriginVerified(req)` → null IP → the prod fail-closed throw at line 170). Confirmed in logs: assessiq.in requests logged `ip: 172.21.0.1` (the Docker-bridge socket fallback from `client-ip.ts`'s enforce-unverified path) while automateedge logged the real CF IP. **Secondary bug:** a *response*-header rule broadcasts the shared secret to every visitor — `ORIGIN_VERIFY_SECRET` was exposed in `assessiq.in` response headers while the bad rule was live.

**Fix:** (1) Recreated the rule as **Modify Request Header**, match "All incoming requests", `Set static x-origin-verify=<secret>`, deployed. Verified: `/take/start` on assessiq.in → 404 (not 429); api log shows the real CF client IP. (2) Rotated `ORIGIN_VERIFY_SECRET` via a zero-downtime bridge: flip app `ORIGIN_TRUST_MODE=log` → update the CF request rule to a fresh 64-hex secret → set `.env` to the new secret + `ORIGIN_TRUST_MODE=enforce` → recreate api/worker. AOP (network-layer `client_auth`) stayed enforcing throughout, so direct-origin spoofing was blocked the whole time. The legacy automateedge zone rule is now moot (that host is a pure Caddy 301).

**Prevention:** (a) Origin-verify is a **request**-header injection — replicating it to a new CF zone MUST use *Modify Request Header*. A *Response* rule both fails origin-verify (app never sees it) AND leaks the secret to clients. Now an explicit, called-out step in `docs/06-deployment.md` § "Domain switch to assessiq.in". (b) Health endpoints are exempt from the rate limiter, so a 200 on `/api/health` does NOT prove origin-verify works — post-cutover, always test a rate-limited route (`/take/start`) and look for non-429. (c) Safe Browsing "Dangerous" on a brand-new domain + login page is a real-time phishing heuristic, not necessarily a blocklist hit — the transparency report was clean; clears with domain age / Search Console review. Manual discipline; a post-cutover smoke asserting a rate-limited route is non-429 would catch (a)/(b).

## 2026-05-21 — Question Bank "Questions" column rendered blank (list API never returned a count)

**Symptom:** The admin Question Bank grid's "Questions" column was empty for every pack. The frontend `PackListItem` type declared `question_count: number`, but the cell rendered nothing.

**Cause:** `GET /api/admin/packs` → `listPacks` → `repo.listPackRows` selected only the bare `question_packs` columns (`PACK_COLUMNS`) and mapped them with `mapPackRow`, which has no `question_count`. The count was never computed server-side, so the JSON omitted the field and React rendered `undefined` as empty. The typed FE interface gave false confidence — a declared field is not a returned field. (`modules/04-question-bank/src/repository.ts` `listPackRows`, pre-`7500abb`.)

**Fix:** `listPackRows` now returns `question_count` via a correlated subquery on `questions`, plus a new `completed_count` (tenant attempts that reached a finished state, via attempts→assessments), both RLS-scoped, typed as `PackListItem[]`. `completed_count` is guarded by `attemptCompletionsQueryable()` (a `to_regclass` check on `attempts`+`assessments`) so a question-bank-only test schema degrades to `0` rather than throwing "relation does not exist". (`repository.ts` `listPackRows` + `types.ts` `PackListItem`; commit `7500abb`.) Considered and rejected: a single mega-query with both counts as correlated subqueries — split out `completed_count` into a guarded grouped query so QB-only test DBs (no lifecycle/attempt tables) keep passing. Excluded: per-pack entitlement filtering of the list (separate concern).

**Prevention:** When a frontend list type declares a field, confirm the list endpoint actually populates it on the wire — TS interfaces don't validate the payload. Recurring theme with the 2026-05-21 mfa.tsx entry: verify the real artifact, not a proxy. Manual discipline; a contract test asserting `/admin/packs` items carry `question_count`/`completed_count` would catch regressions.

## 2026-05-21 — Gmail app password leaked to logs by send-sample-emails redaction bug

**Symptom:** Running `modules/13-notifications/scripts/send-sample-emails.ts` (to send the 9 sample emails to manishjnvk@gmail.com for content review) printed the line `[CONFIG] SMTP host = smtps:REDACTED@gmail.com:<password>@smtp.gmail.com:465` — exposing the production Gmail **app password in cleartext** in the command output / session transcript.

**Cause:** `send-sample-emails.ts:152` redacted the SMTP URL with `SMTP_URL.replace(/:[^@]+@/, ':REDACTED@')`. That regex assumes the credential is the first `:…@` segment. But the production `SMTP_URL` is `smtps://manishjnvk@gmail.com:<app_pw>@smtp.gmail.com:465` — the **username is itself an email containing `@`**, so the regex matched `//manishjnvk@` (the username) and replaced *that*, leaving the password (`<app_pw>@smtp.gmail.com`) untouched in the output. A redaction that only handles the canonical `user:pass@host` shape fails for email-as-username SMTP URLs.

**Fix:** `send-sample-emails.ts:152` now prints only the host:port via `SMTP_URL.replace(/^.*@/, '')` (everything after the LAST `@`) — it never reconstructs or partially-prints the credential portion. **Operational remediation (operator action required):** the leaked Gmail app password must be revoked in Google Account → Security → App passwords and a fresh one issued; `SMTP_URL` in `/srv/assessiq/.env` updated; api + worker recreated.

**Prevention:** (a) Never log a secret-bearing URL by "redacting" the credential — print only the non-secret remainder (host/port). Whitelist what's safe to show, don't blacklist what's secret. (b) Underlying functional issue surfaced by this incident: production sends all mail through **personal Gmail SMTP** with `EMAIL_FROM=AssessIQ <manishjnvk@gmail.com>` — a branded-domain mail service (Resend/SES with assessiq.in SPF/DKIM) is the real fix; tracked as the top email-layer functional follow-up (see SESSION_STATE 2026-05-21). (c) Manual discipline; consider a repo-wide lint that flags `replace(/...@/, ...REDACTED...)` patterns on env-derived URL strings.

**Symptom:** A tenant admin clicks the yellow "Secure your account · Set up authenticator →" banner on `/admin`. URL flickers to `/admin/mfa` and then returns to `/admin`. No enrolment form ever appears. The link looks "not functional" from the user's perspective. Reproduced by manishjnvk@gmail.com against wipro-soc admin.

**Cause:** A spec mismatch between the backend `computeMfaStatus` and the frontend `mfa.tsx` redirect guard. `apps/api/src/routes/auth/whoami.ts:35-45` returns `mfaStatus = 'verified'` for any tenant admin/reviewer whenever `MFA_REQUIRED=false` — TOTP is opt-in for them, the gate is "satisfied" by default, regardless of whether they hold any TOTP at all. `apps/web/src/pages/admin/mfa.tsx:85` then read `session.mfaStatus === 'verified'` as the proxy for "user has completed MFA, nothing to do here" and called `nav('/admin', { replace: true })`. For opt-in admins, that condition is *always* true on page mount — so the route is self-redirecting and the enrol form is unreachable via direct navigation. The MfaNudgeBanner link itself was fine; the dead-end was downstream.

A secondary issue in this session: a first patch round changed only the banner's `<a href>` → `<button onClick={navigate}>` and claimed "deployed and working" based on the bundle containing the new code. Bundle presence is not equivalent to clicking the button and seeing the destination render — the redirect loop was not detectable from grep alone.

**Fix:** `mfa.tsx:85` tightened to `if (session.mfaStatus === 'verified' && session.totpEnrolled === true) { nav('/admin', ...) }`. The redirect now only fires when the user has ACTUALLY enrolled AND the MFA gate is satisfied. Unenrolled admins (mfaStatus='verified', totpEnrolled=false) fall through to the existing enroll/start path. Super-admin first-login (mfaStatus='pending') and verify-after-pre-MFA flows are unchanged because they hit the second branch (`totpEnrolled === true && mfaStatus !== 'verified'` → verify form). Banner code change from the prior patch (button + useNavigate, plus topbar/breadcrumb clickability) is retained.

**Prevention:** (a) **Verify the visible behavior, not just the bundle.** When a UI fix is deployed, follow the actual click chain to the destination page and confirm the destination renders. "The new string is in the served JS" is necessary but not sufficient evidence; redirect loops are invisible to grep. Manual discipline until an automated smoke covers banner→/admin/mfa→enrol-form. (b) The `mfaStatus` field's semantics ("gate satisfied") diverge from its colloquial reading ("user has done MFA"). Any UI logic that branches on `mfaStatus === 'verified'` should also consult `totpEnrolled` to disambiguate the two. Audit candidates: `mfa.tsx`, any future "MFA settings" surface. Recurring theme with RCA 2026-05-19 ("verify the real artifact on the real path, not a proxy") — same failure mode, different surface.

## 2026-05-20 — Magic-link single-click activation is scanner-burnable (admin invite test)

**Symptom:** Operator invited a test admin (`manish.kumar21@wipro.com`) to `wipro-crs` at 09:55:54 UTC. The Platform page showed the row's tenant-status chip as green `active` and the per-row admin-state Chip as `Accepted` — even though the human at wipro had not yet clicked the link. DB confirmed: `users.status='active'`, `user_invitations.accepted_at = 2026-05-20 09:56:17 UTC` (**23 s after creation**), `sessions` row created from IP `57.155.170.164` (Microsoft Azure / Defender for Office 365 ASN) with a Chrome-141-on-Windows UA, `totp_verified=false`, no subsequent activity. Classic email-link-scanner signature: the corporate mail security service GETs the magic link to check it for malware, which **burns the single-use token** and **flips the user pending→active**. Operator could not distinguish "human accepted" from "scanner pre-clicked" on the screen.

**Cause:** `acceptInvitation` in `modules/03-users/src/invitations.ts:240-323` performs *all* state mutation on the bare GET of the invite-accept URL (token lookup → atomic mark-accepted → user `pending→active` flip → session minting). There is no human-gesture confirmation step. Any HTTP client that fetches the URL — Outlook Safe Links, Defender for Office 365, Mimecast, Proofpoint URLDefense — burns the token and silently activates the account from the scanner's IP. Industry-known sharp edge with single-click magic-link flows; not unique to AssessIQ but not yet mitigated here.

**Fix (this session):** Hard-deleted the affected user row in prod under `assessiq_system` role inside a verification tx (CASCADE removed the scanner-IP session; `user_invitations` and `audit_log` rows preserved as forensic trail). Tenant `wipro-crs` retained. SQL audit: `BEFORE user=1 sessions=1 invitations=1 audit=1 / DELETE 1 / AFTER user=0 sessions=0 invitations=1 audit=1`. Platform list now shows `wipro-crs` row with `admin_email=NULL` (existing "—" fallback at `platform.tsx:1425-1433`).

**Prevention:** No prevention shipped this session — RCA filed for visibility. Future hardening options, in order of cost: (a) **two-click flow** — invite-accept URL lands on a "Yes, log me in" confirmation page; no state changes until the user POSTs the confirm form. Defeats 100% of scanner pre-clicks; adds 1 click for humans. Cheapest, most effective. Estimated 2-3 h. (b) IP/UA heuristic at acceptance — block known scanner ASNs (Microsoft 57.x, Mimecast, Proofpoint) and require a fresh GET from a different IP within N minutes. Brittle; not recommended. (c) Two-factor invite where the email contains a 6-digit OTP the user must type. Most secure, highest friction. Tracked as a follow-up against `04-auth-flows.md` mitigation list. **Until shipped, manual discipline:** when an invite shows `Accepted` within < 60 s of issuance with no follow-up MFA enrolment, suspect scanner-burn; verify with the human before considering the user truly active.

## 2026-05-19 — Monetization FE deliverables didn't surface on the real user flow (3 defects, prod testing)

**Symptom:** Operator manual testing of the shipped A1–C features found: (1) the assessment-create form still listed ALL domains for a company admin (B2's "filtered picker" appeared not to work); (2) no help drawer opened on the super-admin billing/entitlements drawer despite C "wiring help"; (3) the entitlement Grant scope_id was a free-text box that accepted junk (`dsfdsf`, `ir` rows were created on `e2e-walkthrough`).

**Cause:** Three FE deliverables passed typecheck/Phase-3 but were never exercised on the actual page/flow they target. (1) B2's filtered-picker code was placed in `assessment-detail.tsx` (the invite/detail page) — the New-assessment form is `assessments.tsx`, which loaded `listDomainsApi()` unfiltered. (2) C "wired help" by adding `data-help-id` HTML attributes, but this app has NO global `[data-help-id]` binder — help only renders via the `<HelpTip>`/`useHelp` component; additionally two C help keys (`admin.billing.usage`, `admin.assessments.content_source`) didn't match their page's key prefix (`WHERE key LIKE page||'.%'`), so even a correct trigger would degrade silently. (3) B1's grant UI shipped scope_id as a raw text input with no domain/pack list to choose from.

**Fix:** `47722db` — picker filter moved to `assessments.tsx` (entitled-domain filter; internal/unlimited exempt via `getCompanyUsage`; fail-open; empty-set message; verified `domains.slug == question_packs.domain == entitlement scope_id` vs prod so it matches B2 exactly); real `<HelpTip>` on the 4 monetization surfaces + the two mismatched help keys renamed to the page-prefix-correct ids (`admin.settings.billing.usage`, `admin.assessments.list.content_source`); new `GET /api/admin/super/tenants/:id/content-scopes` (superAdminOnly, system-role read) drives a scope_id dropdown; billing drawer widened to `min(720px,92vw)`. Junk `dsfdsf`/`ir` entitlements deleted from `e2e-walkthrough`; its baseline restored (free/25, soc active). B2 server enforcement untouched.

**Prevention:** Phase-3 FE checklist additions: (a) a UI deliverable that targets a specific user flow must be verified on *that page/route*, not only by typecheck — name the exact URL in the build contract and confirm the changed file is the one that route renders; (b) "wired help/telemetry attribute" is not done until the drawer/handler actually fires — assert the rendered affordance, and for help, that the key resolves under the page's `LIKE page||'.%'` set. Manual discipline until an automated route-level smoke exists. Recurring theme with RCA 2026-05-18 (B1 backfill test ran a copy, not the real artifact): **verify the real artifact on the real path, not a proxy.**

## 2026-05-18 — Help-seed silently desynced: admin.platform short_text 132 > 120-char generator limit

**Symptom:** During Phase C, regenerating `modules/16-help-system/migrations/0011_seed_help_content.sql` from `content/en/admin.yml` produced a ~1.7k-line diff far larger than the 4 new keys being added — the committed seed was stale by ~46 rows (pre-existing YAML edits since 2026-05-03 were never reflected in the seed: `admin.analytics.cohort_report`, `admin.audit*`, the `admin.grading.rerun`→`admin.grading.rerun.opus` rename, etc.).

**Cause:** `tools/generate-help-seed.ts` enforces `short_text` ≤ 120 chars and aborts on violation. The 2026-05-17 `admin.platform` plain-language rewrite set its `short_text` to 132 chars. From that point the generator failed on every run, so **no help-YAML edit reached the seed SQL for ~15 days** — yet nothing surfaced the failure (generator run is a manual dev step, not CI-gated; prod help is DB-backed and the missing rows just silently never appeared in the drawer). The desync was invisible until a session actually re-ran the generator.

**Fix:** Phase C trimmed `admin.platform` short_text 132→118 (meaning preserved), unblocking the generator; regenerated `0011` (now matches YAML truth — 104 rows). Re-applied to prod: `ON CONFLICT (tenant_id,key,locale,version) DO NOTHING` made it safe/idempotent (only the genuinely-new keys inserted; existing prod rows untouched; the stale `admin.grading.rerun` row is harmless orphan content, pre-existing). Commit `f60256a`.

**Prevention:** (1) the `short_text` length cap must fail **loudly and early** — add a CI/pre-commit check (or a `pnpm` script gate) that runs `generate-help-seed.ts` and fails the build if it errors or if the regenerated SQL differs from the committed one (drift = unseeded content). (2) Phase-3 guardrail: a help-YAML diff whose `short_text` exceeds 120 chars, or that does not include a corresponding regenerated `0011` diff, is a bounce. Tracked as a follow-up (the CI gate is not yet wired). Manual discipline until then: always run the generator after editing `admin.yml` and commit the regenerated seed in the same change.

## 2026-05-18 — Phase B1 backfill 0082 failed at prod apply: bare NULL → text vs uuid

**Symptom:** Applying `modules/19-billing/migrations/0082_entitlements_backfill.sql` to prod errored: `ERROR: column "granted_by" is of type uuid but expression is of type text` (SQLSTATE 42804) at the `INSERT … SELECT DISTINCT … NULL …`. No partial write — single statement under `psql -v ON_ERROR_STOP=1`, failed atomically; `tenant_entitlements` stayed empty (0081 had created it).

**Cause:** `0082` projected a bare untyped `NULL` for the `granted_by UUID` column inside a `SELECT DISTINCT`. PostgreSQL 16 resolves an unknown-type `NULL` under `DISTINCT` to `text` *before* the INSERT target-column coercion, so the text→uuid assignment is rejected. (Without `DISTINCT`, PG would coerce the unknown NULL straight to the target uuid — which is why this is easy to miss.) The B1 backfill **test** (`entitlements-backfill.test.ts`) did not catch it because its `BACKFILL_SQL` was a **hand-copied string**, not the migration file's SQL — and on the test container the same statement did not raise (PG minor-version / planner difference), so the test stayed green while prod failed. Phase-3 critique and the Sonnet adversarial pass both read the migration but neither flagged the untyped-NULL-under-DISTINCT coercion.

**Fix:** `0082` line 62 → `NULL::uuid` (explicit cast — always correct regardless of PG version or `DISTINCT`) + an inline comment. The test's `BACKFILL_SQL` updated to `NULL::uuid` with a comment requiring byte-identity with the migration so it now genuinely mirrors prod. Commit `9f073a5`. Re-applied to prod (idempotent `ON CONFLICT`; the first attempt inserted nothing): `INSERT 0 3`, zero-NULL verification gate PASS.

**Prevention:** (1) Phase-3 critique guardrail — any `NULL` literal inserted into a typed column (esp. under `SELECT DISTINCT`/`UNION`) must carry an explicit `::type` cast; add to the migration-diff checklist. (2) Backfill/migration integration tests must execute the migration file's SQL (read it from disk), not a maintained copy that can silently diverge from prod behaviour. Tracked as a follow-up (the B1 test still uses a copy, now annotated to require byte-identity). (3) Surgical prod apply with `ON_ERROR_STOP=1` worked exactly as intended — it caught the defect atomically with no partial state; keep that as the standard apply harness.

## 2026-05-17 — Create company "INTERNAL ERROR": tenants_status_check missing 'provisioning'

**Symptom:** Every `POST /api/admin/super/companies` (Create company on the Platform page) returned **INTERNAL ERROR** (HTTP 500). Prod logs: `new row for relation "tenants" violates check constraint "tenants_status_check"` (SQLSTATE `23514`) at `modules/02-tenancy/src/service.ts:166`.

**Cause:** `createTenant` inserts the new tenant at `status='provisioning'` (first step of the reviewed soft-create pattern: provisioning → seedTenantTaxonomy → inviteUser → activateTenant flips to `active`). But `0001_tenants.sql` defined the column with an inline auto-named CHECK `status IN ('active','suspended','archived')`. The slice-1 super-admin work shipped `createTenant` + the create-company endpoint but **no migration ever widened the constraint** to allow `'provisioning'`, so the very first INSERT of the orchestration violated it and the whole request 500'd before any tenant row was committed. Same class as RCA 2026-05-13 "migration application is the deploy step" — code shipped, required DDL did not.

**Fix:** `modules/02-tenancy/migrations/0077_tenants_status_provisioning.sql` — `DROP CONSTRAINT IF EXISTS tenants_status_check` then re-`ADD` it as `status IN ('active','suspended','archived','provisioning')`. Pure-additive: prod had only 3 `active` tenants; the new set is a strict superset so no existing row can violate it. Applied surgically (per the never-`tools/migrate.ts` carry-over) + recorded in `schema_migrations` (version + sha256). No app code changed — the constraint now matches what the reviewed code already emits.

**Prevention:** When a service writes a new column value behind a CHECK/enum (here `status='provisioning'`), the same PR must ship the migration that widens the constraint — and a session that ships a `*.sql` must confirm it is actually applied to prod (record version+sha256 in `schema_migrations`; cross-ref RCA 2026-05-13). Phase-3 critique guardrail: a diff that introduces a new literal status/role/enum value written to the DB without a corresponding constraint-widening migration is a bounce.

## 2026-05-17 — Super-admin re-prompted to enrol TOTP on every login (mfa.tsx ignored totpEnrolled)

**Symptom:** A super_admin who had already enrolled TOTP was shown the **Enrol your authenticator** screen (fresh QR + new secret) on every subsequent login. Entering a code from their real authenticator returned "invalid totp code"; they could never reach the verify path — a re-enrol loop. Prod DB confirmed enrollment WAS persisted (`user_credentials` row for user `…0002`: `totp_secret_enc` set, `totp_enrolled_at=2026-05-17 13:40:29Z`).

**Cause:** `apps/web/src/pages/admin/mfa.tsx` decided enrol-vs-verify with a heuristic: "call `POST /api/auth/totp/enroll/start`; if it returns `409 ALREADY_ENROLLED` → show verify form." But `modules/01-auth/src/totp.ts` `enrollStart` has **no already-enrolled guard** and never returns 409 — it unconditionally mints a new 20-byte secret and stages it in Redis. So `mfa.tsx` always took the enrol branch, showed a new QR, and `enroll/confirm` validated the user's code against the *new Redis-staged* secret instead of the *persisted* one. Meanwhile `whoami` already returns the authoritative `totpEnrolled` (from `getEnrollmentStatus` → `user_credentials.totp_enrolled_at`), which `mfa.tsx` ignored. Latent since the MFA-enrollment-UX work (2026-05-15); masked because `MFA_REQUIRED=false` makes normal admins report `mfaStatus='verified'` and skip `/admin/mfa` entirely. Making `super_admin` always-MFA (the correct lockout fix, same day) was the first code path to actually exercise `/admin/mfa` in prod, exposing it.

**Fix:** `mfa.tsx` now routes on `session.totpEnrolled`: `true` → verify mode (no `enroll/start` call — avoids staging/overwriting a new secret), `false`/absent → first-time enrol. The defensive 409 branch is kept in case `enrollStart` later gains the guard. Frontend-only; both `/auth/totp/verify` and `/enroll/confirm` are server-validated and unchanged — no auth-gate logic touched, no adversarial gate required.

**Prevention:** Use the backend-computed `totpEnrolled` signal — never infer enrolment state from a side-effecting endpoint that has no such guard. Optional follow-up (not done — would be load-bearing `01-auth`, needs the gate): add an idempotency/already-enrolled guard to `enrollStart` so it cannot silently re-stage a secret for an enrolled user (defense-in-depth against an accidental re-enrol overwrite). Tracked as a backlog note.

## 2026-05-17 — "role super_admin not authorized" on the tenant dashboard (backend role gate had no hierarchy)

**Symptom:** Immediately after the MFA-bootstrap lockout was fixed and a super_admin logged in end-to-end, the tenant dashboard (`/admin`) showed a red **"role super_admin not authorized"** on the grading-queue panel. The super_admin could reach the Platform page but every tenant-admin API call (gated `roles:['admin','reviewer']`) 403'd.

**Cause:** `modules/01-auth/src/middleware/require-auth.ts:26` did the role check as an exact `!opts.roles.includes(sess.role)` with **no hierarchy**. The frontend `RequireSession` already implemented `super_admin > admin > reviewer > candidate` (slice-2) and PROJECT_BRAIN / memory 1673 documented that as the intended model — but the backend never implemented it, so a logged-in super_admin failed every gate that didn't list `super_admin` explicitly. Same root class as Defect #2 of the MFA-lockout RCA below (which had worked around it by adding `super_admin` to the four TOTP routes' `roles[]`).

**Fix:** `require-auth.ts:26` — role check now also passes when `sess.role === "super_admin"` (apex role satisfies ANY gate). One-directional: only super_admin is apex; non-super roles still exact-match, so `roles:['super_admin']` gates (admin-super.ts, server.ts:229, analytics) still exclude every non-super role. Cross-tenant safety rests on the unchanged structural guarantee: a super_admin session carries the platform tenantId and `tenantContextMiddleware` (session-sourced) RLS-confines every tenant-scoped query to that empty tenant; the genuinely cross-tenant `/api/admin/super/*` endpoints are unchanged (`['super_admin']` + `freshMfaWithinMinutes`, explicit target tenantId). The earlier explicit `super_admin` additions in `totp.ts` roles[] are now redundant-but-harmless; MFA-bootstrap test case D updated (it had asserted the pre-hierarchy AuthzError) with a comment recording the deliberate supersession.

**Prevention:** New `modules/01-auth/src/__tests__/super-admin-role-hierarchy.test.ts` (9 cases): super_admin passes admin/reviewer/candidate/super gates; one-directional guards (reviewer ✗ admin, admin/reviewer/candidate ✗ super-only); normal exact matches unchanged. Adversarial: Sonnet ACCEPT + Opus ACCEPT (7 vectors; cross-tenant reach, non-super escalation, super-only exclusivity, candidate-gate harm, MFA-gate independence all verified safe against the repo). **Guardrail:** when the frontend role guard implements a hierarchy, the backend `requireAuth` must mirror it — a UI that grants a role access while the API 403s it is a latent "logged-in but everything is forbidden" bug. Add to the auth-diff critique checklist alongside the MFA-lockout pattern.

## 2026-05-17 — Super-admin first-login MFA bootstrap lockout (chicken-and-egg)

**Symptom:** A freshly-provisioned `super_admin` (manishjnvk@gmail.com, platform tenant) completed Google SSO via the platform login (`tenant=platform`) but was bounced straight back to `/admin/login` — no MFA screen, no error page. User report: "Google, then login." The prior session's slice-1 handoff had labelled this "verified end-to-end (session minted, MFA-gated 401 until TOTP — correct)" — an **incomplete verification**: the 401 was observed in logs and assumed correct, but nobody followed it to the dead-end (the MFA page is unreachable, so TOTP can never be completed).

**Cause:** Three coupled defects in load-bearing `01-auth`, all introduced by slice-1's `super_admin` always-MFA design interacting with the SPA session gate:
1. `modules/01-auth/src/middleware/require-auth.ts:45` — `requireTotp` was computed `isSuperAdmin ? true : (...)`, forcing TOTP-verified **unconditionally** for super_admin. This overrode the explicit `requireTotpVerified:false` that the read-only state-probe / MFA-bootstrap routes set by design (`whoami`, `logout`, the 4 `/api/auth/totp/*` routes). A pre-TOTP super_admin → `AuthnError` 401 at `/api/auth/whoami` → SPA `useSession()` treats 401 as no-session → `RequireSession` redirects to `/admin/login`. Chicken-and-egg: TOTP required to pass whoami, but whoami must pass to reach the page that sets TOTP. This is the **same bug class as 2026-05-01 obs 534** ("Pre-MFA admin sessions blocked by whoami + logout auth gates"), reintroduced for the new role.
2. `apps/api/src/routes/auth/totp.ts` — the 4 TOTP bootstrap routes were gated `roles:['admin','reviewer']`. The backend role check is an exact `includes()` with NO hierarchy (unlike the frontend `RequireSession`), so `super_admin` 403'd on enrol/verify even if it reached the page. (Memory obs 1673 "super_admin satisfies admin role gates via includes()" is wrong — code is authoritative.)
3. `apps/api/src/routes/auth/whoami.ts:44` — `mfaStatus` was `config.MFA_REQUIRED ? (totpVerified?…) : 'verified'`. In prod `MFA_REQUIRED=false`, so a pre-TOTP super_admin would report `'verified'` (had #1 been fixed alone), making the SPA skip `/admin/mfa` and then 401 on every cross-tenant action.

**Fix:** (commit on `main`, surgical `assessiq-api` rebuild — no migration)
- `require-auth.ts` — honor an **explicit** `opts.requireTotpVerified === false` for every role incl super_admin. Only the 6 probe/bootstrap routes set it (whoami, logout, 4×totp — verified by exhaustive grep). Cross-tenant ACTION routes (`admin-super.ts`) never set it AND additionally require `freshMfaWithinMinutes`, whose gate is independent of `requireTotp` — so the always-MFA invariant on the dangerous surface is provably unchanged.
- `totp.ts` — add `'super_admin'` to the 4 bootstrap routes' `roles[]`.
- `whoami.ts` — extracted `computeMfaStatus(role, totpVerified, mfaRequired)`: super_admin is always-MFA regardless of `MFA_REQUIRED`, so a pre-TOTP super_admin reports `'pending'` → SPA routes to `/admin/mfa`.

**Prevention:**
- New regression suite `modules/01-auth/src/__tests__/super-admin-mfa-bootstrap.test.ts` (7 gate cases incl. the invariant guard: no-flag super_admin still requires TOTP; fresh-MFA never relaxed by the opt-out; role gate still excludes a non-listed role) + `apps/api/src/__tests__/routes/whoami-mfa-status.test.ts` (6 cases). These pin the exact contract that obs 534's fix lacked a test for — which is why the bug class recurred.
- **Recurring-pattern guardrail (Phase 3):** any change that makes a role's TOTP/auth requirement *unconditional* must be checked against the read-only bootstrap routes (`whoami`, `logout`, `totp/*`) — an unconditional gate that ignores `requireTotpVerified:false` re-creates the first-login lockout. Add to the auth-diff critique checklist.
- **Verification-completeness guardrail:** "session minted + 401 until TOTP" is NOT proof a login flow works — a login is only verified when a browser reaches the post-MFA authenticated surface. Slice-1's handoff mislabelled an observed 401 as success. Future auth verification must trace the redirect target to a rendered authenticated page, not stop at the first expected-looking 401 (cross-ref RCA 2026-05-13 "smoke tests must exercise actual route paths, not the SPA shell").
- Adversarial sign-off: Sonnet ACCEPT + Opus-takeover ACCEPT (7 attack vectors; blast radius grep-confirmed; non-super truth table byte-identical). GLM-5.1 leg blocked by the source-exfil guard; Opus-takeover substituted per the `feedback-adversarial-reviewer-routing` stale-agent ladder.

## 2026-05-15 — Admin lockout from /api/auth/* IP bucket: allowVerifiedAdminBypass dead code

**Symptom:** Admin login flows (`/api/auth/google/start` → `/api/auth/google/cb` → `/api/auth/whoami`) repeatedly returned HTTP 429 in production. The `allowVerifiedAdminBypass` mechanism — intended to give verified admins a higher IP rate limit on selected auth endpoints — was silently inoperative: the bypass predicate required `session.totpVerified === true`, which is never true while `MFA_REQUIRED=false` (the production setting).

**Cause:** `rate-limit.ts:shouldBypassIpBucket()` evaluated `session.totpVerified === true` unconditionally. With `MFA_REQUIRED=false`, no admin session ever sets `totpVerified=true`, so the bypass never fired. The 2026-05-13 MFA-aware fix (`007f1f7`) corrected the predicate for `MFA_REQUIRED=false`, but the opt-in whitelist design remained fragile: routes had to pass `allowVerifiedAdminBypass: true` explicitly, and the IP bucket was scoped to `/api/auth/*` only, meaning the fix required both a correct predicate AND correct per-route opt-in across the route layer.

**Fix:** Role-aware IP bucket redesign (2026-05-15). `shouldBypassIpBucket()` replaced by `resolveIpBucketMax(req)`, which returns a role-appropriate max for every request with no bypass concept required:
- `modules/01-auth/src/middleware/rate-limit.ts` — rewrite; `allowVerifiedAdminBypass` option removed; bucket applies to all routes at role-derived max.
- `apps/api/src/middleware/auth-chain.ts` — single `rateLimitMiddleware()` instance; `allowVerifiedAdminBypass` removed from `AuthChainOpts`.
- `modules/00-core/src/config.ts` — four new env vars `RATE_LIMIT_IP_{ADMIN,USER,ANON,APIKEY}` with Zod `.default()` (zero-config).
- `apps/api/src/routes/auth/{whoami,google,logout}.ts` — `allowVerifiedAdminBypass: true` calls removed.
- Redis key: `aiq:rl:auth:ip:<ip>` → `aiq:rl:ip:<ip>` (old keys expire naturally within 60s).

**Prevention:** No opt-in bypass mechanism exists in the new design. IP limit scales with session role automatically — any new route that runs `authChain()` inherits the correct bucket without any flag. B1–B12 bypass test cases removed; T1–T5 role-tier tests + N1 (admin 101× on `/api/auth/google/start` → 429, proving bypass removal) added to `modules/01-auth/src/__tests__/middleware.test.ts`.

## 2026-05-15 — Pre-flight decision pins in SKILL.md escape the decision log

**Symptom:** Retroactive audit (2026-05-15) found that Phase 4 (12-embed-sdk) had zero representation in PROJECT_BRAIN.md's decision log, despite 13 locked design decisions in `modules/12-embed-sdk/SKILL.md` committed in `b7dfaa9`. A future session starting from Phase 0 reads would not inherit any Phase 4 decisions. The same audit surfaced 6 other missing entries for decisions made during 2026-05-13–14 sessions.

**Cause:** The convention "pin decisions to the module's SKILL.md before implementation" was followed correctly, but SKILL.md files are module-scoped. PROJECT_BRAIN.md is the cross-phase orientation surface that survives session context loss and is read at Phase 0. When a "pre-flight pin" commit has no corresponding kickoff plan doc in `docs/plans/`, there is no workflow step that bridges from SKILL.md → decision log.

**Fix:** `0e3bb52` — backfilled 7 missing entries and enriched 6 existing entries with commit refs in PROJECT_BRAIN.md decision log.

**Prevention:** When authoring a `docs(embed/module): pin N decisions before phase N` commit, include a note in SESSION_STATE.md's Next line: "Add key decisions from SKILL.md to PROJECT_BRAIN.md decision log." Alternatively: the same-PR docs rule (CLAUDE.md § Working agreements) should be read as including the decision log — if the decision is significant enough to pin in SKILL.md, it is significant enough to log in PROJECT_BRAIN.md. Phase 3 bounce condition (proposed): if a diff creates or modifies a `SKILL.md` section titled "Decisions" and no corresponding PROJECT_BRAIN.md row is added in the same commit, flag it in critique.

## 2026-05-15 — Systemic gap: `tenantContextMiddleware` and `magic-link.ts` have no test coverage on load-bearing paths

**Symptom:** File-shape test-coverage audit (2026-05-15) found 2 HIGH-severity gaps and 1 MEDIUM-severity gap across the 5 load-bearing modules (00-core, 01-auth, 02-tenancy, 07-ai-grading, 14-audit-log). `tenantContextMiddleware` in 02-tenancy — the Fastify hook that issues BEGIN / SET LOCAL ROLE / `set_config('app.current_tenant', …)` / COMMIT or ROLLBACK for every request — has no dedicated test. `magic-link.ts` and `crypto-util.ts` in 01-auth — candidate token generation, expiry, and single-use enforcement — also have no dedicated tests. `14-audit-log`'s `archive-job.ts`, `webhook-fanout.ts`, and `routes.ts` are fully untested (append-only invariant IS covered by `audit.test.ts`).

**Cause:** Incremental delivery — each module shipped with tests against its primary business logic but skipped infrastructure-glue layers: the middleware that initialises DB transaction scope, the crypto primitives called indirectly through higher-level tests, and the secondary operational paths (archiving, event fanout) added later without test investment.

**Fix:** No code changed — this is a documentation and prioritisation record. Full coverage map: `docs/12-test-coverage.md`.

**Prevention:** Proposed test-investment order (highest risk first):
1. **02-tenancy** — `tenantContextMiddleware` integration test: verify BEGIN / SET LOCAL ROLE / COMMIT / ROLLBACK lifecycle; cross-tenant request isolation at the middleware layer (not only DB-level RLS).
2. **01-auth** — `magic-link.ts` unit tests: token generation, expiry enforcement, single-use guard; `crypto-util.ts` HMAC round-trip correctness.
3. **14-audit-log** — `archive-job.ts` and `webhook-fanout.ts` unit tests with mocked S3 client and HTTP client.
4. **03-users** — invitations, normalize, redis-sweep paths.
5. **06-attempt-engine** — `routes.candidate.ts` and `routes.take.ts` (autosave + submit flows including rate-cap).
Treat each item as its own focused session; do not batch across modules.

## 2026-05-13 — Verify path silently 404/500 in prod: Caddy matcher gap + missing migrations + RLS cast crash

**Symptom:** While smoke-testing Phase 5 Session 7's new `/og.png` endpoint, *every* request to the public `/verify/*` surface in production returned 404 (from Caddy) or HTML 404 (from the SPA shell) — never reaching the API. Once Caddy was patched, requests hit Fastify but returned HTTP 500 with `relation "certificates" does not exist`. After migrations were applied, requests returned 500 with `invalid input syntax for type uuid: ""`. The verify feature has been cosmetically broken in prod since Phase 5 Session 3 (2026-05-11); nobody noticed because nothing else actually links to `/verify/*` yet, and the prior session's smoke test (`curl /admin/certificates → 200`) only exercised the SPA route, not the API.

**Cause:** Three independent gaps stacked atop each other.

1. **Caddy matcher gap.** `/opt/ti-platform/caddy/Caddyfile` line 82 sets `@api path /api/* /embed* /help/* /take/start` for the `assessiq.automateedge.cloud` block. Session 3 (`9ce3ca5`?) registered `GET /verify/:credentialId` in Fastify, but the Caddyfile was never updated to route `/verify/*` to the assessiq-api upstream on host port 9092. Requests fell through to the default `handle` block (assessiq-frontend on 9091), which returns SPA HTML 200 for the page route and 404 for any sub-path with an extension (`/og.svg`, `/og.png`).
2. **Migrations 0046 + 0074 never applied.** The certificates table + RLS policies + public-verify GUC policy were committed to the repo on 2026-05-11 and the *code* was deployed (commit `2835680` and friends), but no session ran `psql < 0046_certification_init.sql` or `0074_public_verify_policy.sql` against the live DB. `schema_migrations` topped out at `0044`. Every cert SELECT in prod was therefore failing with `relation "certificates" does not exist` (logged at ERROR; nobody was watching the verify path).
3. **`tenant_isolation` RLS cast vs OR-evaluation hazard.** Migration `0046_certification_init.sql` defined the standard `tenant_isolation` SELECT policy with `USING (tenant_id = current_setting('app.current_tenant')::uuid)`. Migration `0074_public_verify_policy.sql` added a parallel `public_verify_lookup` SELECT policy gated on `current_setting('app.public_verify') = 'true'`, intended to grant cross-tenant read access from the public verify path. The intent was OR-style: any policy returning TRUE grants access. The hazard: Postgres evaluates the OR'd policy expressions eagerly enough that `tenant_isolation`'s cast on `''` (because `withPublicVerifyContext` set `app.public_verify` but not `app.current_tenant`) **threw `22P02 invalid input syntax for type uuid` before the OR could short-circuit on `public_verify_lookup`'s TRUE result**. Result: a SELECT that *should* have been granted by the public-verify policy instead crashed the whole query.

**Fix:**

1. `58759d7` — `modules/18-certification/src/repository.ts:198-210` (`withPublicVerifyContext`): set `app.current_tenant` to the reserved UUID_NIL sentinel (`00000000-0000-0000-0000-000000000000`) inside the transaction, in addition to setting `app.public_verify=true`. The sentinel makes `tenant_isolation`'s cast succeed; the equality fails (no real tenant uses UUID_NIL); access falls through to `public_verify_lookup` as designed. New R9 regression test in `public-repository.test.ts` pins the SET inside the transaction. No migration change.
2. **VPS Caddyfile** `/opt/ti-platform/caddy/Caddyfile:82` — added `/verify/*` to the assessiq `@api path` matcher. Backed up to `/opt/ti-platform/caddy/Caddyfile.bak.20260513T074746Z`. Truncate-write via `awk` + `tee` (per RCA 2026-04-30 bind-mount-inode protocol — `sed -i` and `mv` are still forbidden). Caddy reload-validated and reloaded successfully; no other site blocks touched. The Caddyfile is not in the repo; the change is documented here + in the Session 7 handoff.
3. **VPS DB** — applied `0046_certification_init.sql` then `0074_public_verify_policy.sql` to the live `assessiq` DB; recorded both in `schema_migrations` with their SHA256 checksums. Pure-additive (one new table, four RLS policies, two indexes — no existing data touched).

**Prevention:**

- **Same-PR deploy-channel mapping.** Any new public-path route registered in Fastify (i.e. anything *outside* `/api/*`, `/embed*`, `/help/*`, `/take/start`) must update the Caddyfile @api matcher and call that out in the same session's SESSION_STATE.md. A new top-level route is invisible to the production proxy by default; the deploy is incomplete until the proxy can see it. Consider checking the Caddyfile into the repo as `infra/caddyfile/assessiq.snippet` so the change is reviewable in the same PR (deferred — broader infra refactor).
- **Migration application is the deploy step, not the merge step.** CLAUDE.md rule #8 ("commit → deploy → document → handoff") was followed for Session 3 *for the code*, but the migration-application step was implicitly tied to the commit and never actually ran. Going forward, every session that ships a `*.sql` migration must include a `Migrations applied:` line in SESSION_STATE.md listing each version + checksum + the `schema_migrations` INSERT statement. The presence of new `.sql` files in the diff is a Phase 5 verification gate: read `schema_migrations` from the live DB to confirm. (Future: add a pre-deploy check `git ls-files modules/*/migrations/*.sql | diff - <(psql -c "SELECT version FROM schema_migrations ORDER BY version")` and fail if non-empty.)
- **RLS policies with type casts on session GUCs must guard the cast.** The hazard is generic — any SELECT policy of the form `tenant_id = current_setting('app.foo')::uuid` will crash if `app.foo` is unset *and* the policy is OR'd with another (intended-to-permit) policy. The session-local fix here is a sentinel UUID; the migration-level fix is `current_setting('app.current_tenant', true) IS NOT NULL AND current_setting('app.current_tenant', true) <> '' AND tenant_id = current_setting('app.current_tenant', true)::uuid`. Future RLS-policy reviews (codex:rescue / sonnet+glm) should flag any unguarded cast in `USING` / `WITH CHECK` as a Phase 3 bounce condition — listed alongside the existing "Multi-tenancy guard" bounces in CLAUDE.md § Phase 3.
- **Smoke tests for "all routes reachable" need to exercise actual route paths, not the SPA shell.** Session 5's "all routes return HTTP 200" smoke (`/`, `/admin/certificates`, `/candidate/certificates`) only hit the React SPA — those paths return the SPA's `index.html` from the frontend container regardless of whether the API route exists. A real reachability smoke for an API route is `curl -s -o /dev/null -w '%{http_code}\n'` followed by inspection of the API container's request log to confirm the route was *actually* hit. Worth automating as part of post-deploy.

## 2026-05-12 to 2026-05-13 — Sharded generation retry-loop: round 2 (FORBIDDEN list) + round 3 (CORRECT EXAMPLE + MCP inline rejection)

**Cross-reference:** See the 2026-05-09 → 2026-05-11 entry for the original incident, the first SKILL.md fix (`6fb4f5d`), the MCP rejection-logger (`ab39667`), and the second SKILL.md fix (`573aed7`, 2026-05-10b versions).

**Symptom:** Round 2 (after the original RCA closed): count=15 production smokes continued to fail intermittently while count=2 verification smokes passed. Attempt `019e1872` SIGTERMed at the scenario chunk at ~688 s with +9 MCP rejection-log entries across all five question types. Round 3: `5ade451`'s tightening (FORBIDDEN list + anti-examples) cured the patterns it explicitly targeted, but the model invented NEW wrong shapes for types not previously observed at failure. KQL `tables` was emitted as string → object → array-of-objects across three consecutive retries — converging on more elaborate wrong, not on the canonical `string[]`. Separately, the subjective chunk SIGTERMed via a wrong-tool call (`submit_rubric` instead of `submit_questions`) — no MCP rejection-log entry, budget consumed silently. Attempt `019e1eef` recorded `chunks_failed=2` (kql + subjective) at 783 s.

**Cause:**

1. **Round 2 cause (`5ade451` motivation).** `573aed7` introduced recovery rules but did not enumerate the wrong-field-name patterns the model emits on first try. Self-healing worked at count=2 (3 retries fit inside the 810 s budget for count=3 chunks); at count=15 the larger KB slice increases per-question latency, so a retry that is also rejected can exhaust the remaining budget. The +9 rejections from `019e1872` surfaced concrete patterns absent from any FORBIDDEN list: `step_dependency: true` (boolean, not enum string); content under a `scenario` or `questions` subkey; steps as `{id, step, points, text}` instead of `{prompt, expected}`; `scenario_text` / `tasks` / `artifacts_provided` as top-level keys; steps as plain strings; `log_format` as verbose prose instead of enum value.

2. **Round 3 cause (`5d05d15` motivation).** A FORBIDDEN list only covers patterns the model has emitted *before*. For KQL, three consecutive retries each produced a more elaborate wrong structure: retry 1 — wrong top-level keys (`scenario`, `task`, `schema`, `solution`, `hints`); retry 2 — correct top-level keys but `tables` as a schema-description object `{"SecurityEvent": {"EventID": "int", ...}}`; retry 3 — `tables` as an array of schema objects `[{"name": "SecurityEvent", "columns": [...]}]`. The model interpreted `tables` semantically (as a schema descriptor) rather than literally (as a plain list of table-name strings) and elaborated that misinterpretation on each retry. Negative examples under-specify the target; the model needs a positive canonical anchor. The subjective SIGTERM was a distinct failure mode: the model called `submit_rubric` instead of `submit_questions` — no Zod rejection reached, no rejection-log entry, entire budget consumed on the wrong tool path.

**Fix:**

- `5ade451` (2026-05-12a) — `generate-scenario/SKILL.md`: VALID VALUES section for `step_dependency` (string, not boolean); expanded FORBIDDEN list + anti-example block for `scenario_text` / `tasks` / `artifacts_provided` wrapper; forbidden step-level keys expanded to include `step`, `id`, plain-string steps, and missing-`expected` patterns. `generate-log-analysis/SKILL.md`: `log_format` VALID VALUES table with semantics per enum member; verbose prose strings added to FORBIDDEN. `generate-kql`, `generate-mcq`, `generate-subjective`: parallel FORBIDDEN-list expansions from the `019e1872` rejection-pattern analysis. All five `generate-*/SKILL.md` bumped 2026-05-10b → 2026-05-12a. No MCP schema change.

- `5d05d15` (2026-05-13a) — two parts:
  - **D1 SKILL.md**: end-of-file CORRECT EXAMPLE blocks for all five types — full syntactically-valid payloads pulled from recent accepted questions. KQL: explicit `tables: ["SecurityEvent"]` rule ("ARRAY OF STRINGS, not schema descriptions") plus DO NOT blocks reproducing the wrong `tables` shapes from `019e1eef` verbatim. `generate-scenario/SKILL.md`: top-of-file REPEATED VIOLATIONS callout for `scenario_text` / `tasks` / `artifacts_provided` / `step` / `question` patterns that persisted through `5ade451`. All versions bumped 2026-05-12a → 2026-05-13a.
  - **D2 MCP** (`tools/assessiq-mcp/src/tools/submit-questions.ts`): new `CANONICAL_EXAMPLE_BY_TYPE` constant (line ~59); `formatIssues()` extended to accept a `type` argument and append `"CORRECT SHAPE EXAMPLE for type '<type>': <json>"` after the issue list (new signature at line ~412); 4 KB total message cap (example truncated before issues if exceeded); issue cap lowered 15 → 10. `formatIssuesForLog()` helper preserves full pre-truncation issues for the JSONL file log. `logRejection()` unchanged. 6 new tests; suite 22 → 28 (28/28 pass).

**Prevention** (addendum — the five foundational lessons remain in the 2026-05-09 → 2026-05-11 entry):

1. **Positive examples beat negative examples.** A FORBIDDEN list pre-empts patterns the model has emitted *before*; a CORRECT EXAMPLE block anchors the model on the target shape for patterns it might otherwise invent. End-of-file placement matters — the model re-reads the bottom of the SKILL.md when constructing its output.

2. **MCP feedback messages should include canonical examples inline.** Zod path/expectation text is useful for *known* field-name mistakes; it is ineffective when the model has misinterpreted the entire content shape. An inline `"CORRECT SHAPE EXAMPLE for type 'kql': {...}"` appended to the rejection turns each retry into a high-information correction (`submit-questions.ts:~412`, commit `5d05d15`).

3. **count=2 verification is necessary but not sufficient.** `019e1ed4` (success, 0 chunks_failed, 895 s) was followed 30 minutes later by `019e1eef` (partial, 2 chunks_failed, 783 s) at the same count=15. Per-chunk retry budget tightens as chunk size increases; a single clean count=15 run is not a stable gate. The G1 criterion (5 consecutive clean runs) is the correct bar.

4. **The model has a generative capacity to invent structurally elaborate wrong shapes.** Three tightening rounds + canonical example anchors appear to converge. If a round 4 surfaces a NEW pattern despite CORRECT EXAMPLE blocks, the structural path is: split count=3 scenario into count=1 runs, OR relax the Zod schema and normalise server-side, OR add additional per-type examples for the failure-prone type.

5. **Wrong-tool failures are invisible to the MCP rejection logger.** A chunk that SIGTERMs with `chunks_failed > 0` but no rejection-log entry in its window was killed before `handleSubmitQuestions` was reached. Check `generation_attempts.stderr_tail` for wrong-tool patterns; add a "WRONG TOOL — DO NOT USE" callout to the SKILL.md for the affected type.

**Cross-references:**
- `runtime-baseline.json` `known_gaps` PARTIAL retry-loop entry — proposed update text: replace PARTIAL entry with `"RESOLVED (2026-05-13, rounds 2+3) — Three-round SKILL.md tightening + MCP inline canonical examples (573aed7 → 5ade451 → 5d05d15). Last clean count=15 smoke: 019e1f20 (success, 0 chunks_failed, 678 s). Mark CONFIRMED after 5 consecutive G1-qualifying runs."` DO NOT apply until G1 campaign completes.
- `docs/11-observability.md` §22 — documents `mcp-rejections.log` which surfaced the progressive-wrong-shapes diagnosis (commit `cb04f99`).
- Original entry (2026-05-09 to 2026-05-11) — five foundational prevention lessons not duplicated here.

## 2026-05-11 — Certificate issued_at millisecond drift (would break every verify)

**Symptom:** Session 3's public verify endpoint would have failed for 100% of certificates.
`issueCertificate` signed the HMAC payload with `new Date().toISOString()` which produces
`'2026-05-11T17:46:23.456Z'` (3 fractional digits). The DB projection uses
`to_char(issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` which strips
milliseconds. The verify endpoint would recompute the HMAC from the projected
`'2026-05-11T17:46:23Z'` string and compare against the stored hash computed from
`'2026-05-11T17:46:23.456Z'` — byte mismatch on every cert, red badge every time.

**Cause:** `modules/18-certification/src/service.ts:196` — `const issuedAt = new Date().toISOString()`.
JavaScript's `Date.toISOString()` always emits 3 fractional digit seconds (`.000Z` even
when the wall clock is exactly on a second boundary). The CERTIFICATE_PROJECTION in
`repository.ts:77` uses a `to_char` format that strips them. The two sides of the
HMAC pipeline had different string representations of the same timestamp.

**Fix:** `modules/18-certification/src/service.ts` — changed to
`const issuedAt = new Date().toISOString().slice(0, 19) + 'Z'` which produces
`'2026-05-11T17:46:23Z'` with no dot, matching the `to_char` projection exactly.
The SKILL.md D6 decision ("issued_at microseconds stripped") was documented but the
implementation did not follow it.

**Prevention:** Round-trip regression test added in `src/__tests__/service.test.ts`
(R1 suite): issues a cert, reads back the `issued_at` from the inserted row, reconstructs
the canonical payload, recomputes the HMAC, asserts byte-equality with the stored
`signed_hash`. Without the fix this test fails; with it the test passes.

## 2026-05-11 — Finding C: `inviteUsers` papered over a missing tenant.name fallback

**Symptom:** Phase 1 closure-audit Drill 1 failed at the invite step. `13-notifications`
`sendAssessmentInvitationEmail` rejected the payload with a Zod `.min(1)` violation on
`tenantName`. The whole `withTenant` transaction rolled back — invitation row was never
persisted and no email was logged. Drills 3 (step 5) and 4 were blocked downstream.

**Cause:** Two-step regression. The original ship of `modules/05-assessment-lifecycle/src/service.ts`
passed `tenantName: ""` to the email shim (SKILL.md status note "tenantName is passed as
empty string"). Commit `d681ec5` added a tenant DB fetch but with a permissive fallback
chain — `modules/05-assessment-lifecycle/src/service.ts:697`:
`const tenantName = tenantRow?.name || tenantRow?.slug || tenantId;`. That silently swapped
the email body's tenant label from the canonical name to a slug (and, in the null-row case,
to the bare UUID) — defeating the validator's intent rather than honouring it. The validator
is correct; the caller was making it permissive.

**Fix:** `modules/05-assessment-lifecycle/src/service.ts:691-708` — inside the existing
`withTenant` transaction (same client, RLS-scoped), fetch the tenant row; throw
`NotFoundError{code: TENANT_NAME_MISSING}` if the row is null and
`ValidationError{code: TENANT_NAME_MISSING}` if `name?.trim()` is empty. No fallback to
slug, no fallback to id. New error code in
`modules/05-assessment-lifecycle/src/types.ts:199` (`TENANT_NAME_MISSING`). Three unit
regressions added in `src/__tests__/invite-email.test.ts`: happy-path (`tenantName === "Acme Corp"`,
never the id, never empty), null-tenant-row throws and skips dispatch, empty-name throws
and skips dispatch.

**Prevention:** Manual discipline for now — the inviteUsers callsite is the only one in 05
that constructs a payload requiring a non-empty tenant name (grep confirmed). A
type-level `NonEmptyString` guard at the `13-notifications` input boundary is the proper
long-term fix; deferred because (a) it should live next to the Zod schemas in
`13-notifications` and (b) module 13 is locked in this session under the orchestrator's
"validator stays as-is" constraint. Filed as an open question for the orchestrator.

## 2026-05-09 to 2026-05-11 — Sharded generation retry-loop: SKILL.md / Zod schema drift

**Symptom:** Four sharded-smoke attempts (019e103c, 019e11a2, 019e128e, 019e1293) each recorded
`chunks_failed > 0` on scenario and/or log_analysis types. `stderr_tail` showed `(none)` — SIGTERM
fires before the subprocess flushes stderr, so the MCP rejection payload was invisible at incident
start. A separate eval fixture-mismatch (`score-candidate` "unknown source ids") was layered on
top on the 019e103c session and masked structural health; resolved independently in commit `ce00575`
(DO NOT re-open here).

**Cause:**

1. **(First hypothesis, ruled out) Timeout too tight.** Attempt 019e103c showed the model emitting
   `submit_questions` three times (+51 s, +200 s, +290 s into the chunk), with the 2nd and 3rd
   calls carrying `tool_input_keys=[]`. Commit `a124812` bumped `GENERATION_PER_ITEM_TIMEOUT_MS`
   180 → 240 s (`modules/07-ai-grading/src/runtimes/claude-code-vps.ts:89`; new formula: 90 + 720
   = 810 s at count=3). Did **not** cure the failure. The retry-loop itself was the cause, not
   wall-clock duration. Recorded here so the next investigator does not re-propose the same
   constant tweak.

2. **Zod `.strict()` schema / SKILL.md HARD RULE box mismatch (commit `6fb4f5d`).** Two
   structural errors in SKILL.md examples disagreed with the MCP schemas in
   `tools/assessiq-mcp/src/tools/submit-questions.ts`:
   - `ScenarioContent.steps` Zod schema is `{prompt, expected}.strict()` (lines 105-106).
     Pre-fix `generate-scenario/SKILL.md` HARD RULE box showed MCQ-style
     `{id, type, prompt, options, correct}` — every first-try scenario submission was rejected
     by `.strict()` before the model could see a useful error.
   - `KqlContent.strict()` rejects any unrecognised key. The first kql Output Format example
     included a `hint` field absent from the schema — identical first-try rejection pattern.
     `6fb4f5d` corrected both HARD RULE boxes and replaced the "exactly once" tool-use rule
     with an explicit recovery rule. Post-deploy smokes 019e1293 (scenario) and 019e128e
     (log_analysis) still failed.

3. **Residual prose and enum mismatch (commit `573aed7`).** `6fb4f5d` fixed the HARD RULE box
   but not the Quality Standards prose above it. The line
   `"Individual steps use \`type: \"mcq\"\` for decision-point questions"` remained at
   `generate-scenario/SKILL.md:55` (6fb4f5d version). The model reads SKILL.md top-down; the
   prose anchored its first attempt to MCQ-shaped steps; the residual "exactly once" wording
   (not fully excised in 6fb4f5d) let the model exit after one rejection without retrying.
   Separately, `generate-log-analysis/SKILL.md:99` (6fb4f5d version) showed
   `"log_format": "syslog" | "json" | "csv" | "freeform"`. The `LogAnalysisContent` Zod enum
   (`submit-questions.ts:88`) is `json|syslog|windows_event|freeform` — `csv` is not a member
   and `windows_event` was absent from the SKILL entirely. The model emitted `"csv"` for
   Zeek-format logs; all three retries were rejected.

**Fix:**

- `a124812` — `claude-code-vps.ts:89`: `GENERATION_PER_ITEM_TIMEOUT_MS` 180 → 240 (belt-and-
  braces; did not cure root cause).
- `6fb4f5d` — `generate-scenario/SKILL.md` HARD RULE box: steps rewritten to `{prompt, expected}`.
  `generate-kql/SKILL.md` first example: `hint` removed; added to FORBIDDEN synonyms.
  Tool-use policy in both SKILLs: "exactly once" → explicit recovery rule. (Partial fix —
  Quality Standards prose and log_analysis enum left untouched.)
- `ab39667` — `tools/assessiq-mcp/src/tools/submit-questions.ts:15` (`logRejection()`): appends
  JSONL to `/var/log/assessiq/mcp-rejections.log` on every `isError=true`. Entry carries
  timestamp, pid, inferred type, Zod issues, and 2 KB payload excerpt. Diagnostic surface only —
  no schema or prompt change. Requires MCP dist rebuild + api container recreate on VPS.
- `573aed7` — `generate-scenario/SKILL.md` Quality Standards prose: "Individual steps use
  `type: \"mcq\"`" removed; steps contract unified with HARD RULE box; exactly-once contradiction
  resolved. `generate-log-analysis/SKILL.md`: `log_format` enum aligned to Zod
  (`json|syslog|windows_event|freeform`); `windows_event` guidance added; `csv` moved to FORBIDDEN.
  Both SKILL versions bumped to `2026-05-10b`. Suspected full cure; re-baseline smoke pending.

**Prevention:**

- **Audit the whole SKILL.md, not just the HARD RULE box.** The model reads top-down. A
  "type: 'mcq'" prose line above a corrected HARD RULE silently re-anchors the first attempt.
  When changing any SKILL.md example, `grep` the entire file for the OLD wording across every
  section — Quality Standards, Output Format, HARD RULE, FORBIDDEN, tool-use policy footer.
- **Zod `.strict()` schema changes must land with a paired SKILL.md edit in the same commit.**
  A field added/renamed/removed without a matching SKILL.md update guarantees the next smoke will
  fail. Follow-up candidate: lint that diffs the SKILL.md JSON example against `z.toJSON()` at
  CI time — **not yet shipped**.
- **Log rejection payloads before investigating.** Early sessions burned hours grepping host-side
  logs for `tool_input_keys` sequences. `mcp-rejections.log` (`ab39667`) lets the next
  investigator query rejection JSONL directly. Wire this surface before the next class of incident.
- **Don't bump timeouts as a first response.** When `chunks_failed` shows SIGTERM (exit 143) with
  `stderr_tail "(none)"`, the subprocess was killed inside the retry-loop, not after a slow run.
  Go to log archaeology + schema audit first.
- **Single-type smokes via `SMOKE_TYPE` (commit `5d9b548`) cost ~1/5 of a full smoke.** Use them
  for fix-verification loops; reserve `count=15` for G1/G3 gate progression.

**Open follow-ups (out of scope for this incident):**
- SKILL.md ↔ Zod schema lint at CI (not yet shipped)
- Auto-refresh `attempt_summary_mv` on grade (Phase 3.D)
- Eval re-baseline after `573aed7` deploy (post-verification smoke pending in a separate session)

## 2026-05-09 — pack-detail "pageSize must not exceed 100" blocks question list on packs with 200+ questions

**Symptom:** Admin pack-detail page rendered "Couldn't load questions. pageSize must not exceed 100" whenever a pack had more than 100 questions (typical for L1/L2/L3 fully-populated packs). The fetch `GET /admin/questions?pack_id=…&pageSize=500` reached the API, passed `parsePagination()` (cap=500 in `routes.ts`), but was rejected by `assertPageSize()` inside `service.ts` because `MAX_PAGE_SIZE` there was still `100`.

**Cause:** Two-layer validation with mismatched caps. `routes.ts::parsePagination()` was raised to 500 in an earlier session, but `service.ts::MAX_PAGE_SIZE` was a separate constant that was never updated. The UI error card showed the raw service error string ("pageSize must not exceed 100") which is the `MAX_PAGE_SIZE` value interpolated into the message at `modules/04-question-bank/src/service.ts:113`.

**Fix:**
- `modules/04-question-bank/src/service.ts:58` (commit `bb0176a`): `MAX_PAGE_SIZE = 100` → `MAX_PAGE_SIZE = 500`. Caps now agree at every layer (routes validation → service assertion → SQL LIMIT).
- `modules/04-question-bank/src/routes.ts` comment (this commit): updated to record the 2026-05-09 bump date and rationale.
- Existing UI error card in `modules/10-admin-dashboard/src/pages/pack-detail.tsx` already shows "Couldn't load questions. [Retry]" (added in a prior session); no UI change needed.

**Prevention:** Any two-layer pagination validation (route guard + service assertion) must keep both constants in sync. When raising a cap at the route layer, search for corresponding service-layer `MAX_*` or `assertPage*` symbols and update them in the same commit. The service.ts constant is the authoritative upper bound; routes.ts is an ergonomic early-reject.

## 2026-05-09 — claude auth state mount: per-file approach broken across version upgrades

**Symptom:** `assessiq-api` claude subprocess exited code 1 with "Not logged in · Please run /login" even though host's claude was authenticated and working. Three iterations of partial fix (chmod o+r, chown to UID 1000, individual rw mounts on oauth_token files) all left the container "Not logged in" because each ignored the actual missing file.

**Cause:** claude 2.1.137 introduced `.credentials.json` (mode 600, root-owned) as the new primary auth file; legacy `oauth_token` files became vestigial. The per-file bind-mount in `infra/docker-compose.yml` only listed the legacy files, so the container had no `.credentials.json`. Separately, `.claude.json` (the main config file) lives at `/root/.claude.json` — one level above the `.claude/` directory — and was never mounted. Whenever claude upgrades and adds new state files, per-file mounts silently miss them and report "Not logged in".

**Fix:**
- `infra/docker/assessiq-api/Dockerfile` (commit `607f636`): `USER node` → `USER root` so the container can read mode-600 files without ownership gymnastics.
- `infra/docker-compose.yml` (commit `607f636` + `de49d89`): replaced per-file mounts with whole-directory mount (`/root/.claude:/home/node/.claude:rw`) plus explicit `/root/.claude.json:/home/node/.claude.json:rw` for the config file that lives one level above. `prompts/skills` overlay remains `:ro`.
- Host chown reverted to `root:root` — no longer needed once container runs as root.
- Verified: `docker exec assessiq-api id` → `uid=0(root)`, `echo hi | claude -p "reply OK"` → "OK" with no warnings.

**Prevention:** Container-side state directories that mirror host CLI state should always be whole-directory mounts unless there's a specific reason to filter. Per-file mounts are a maintenance trap — every CLI version bump can silently add files the mount doesn't list. **Anti-pattern to refuse:** mounting individual files from `/root/.claude/` or using chown to uid 1000 gymnastics. The lint-deploy-procedure.ts (queued for Phase 4+) should add a check: any directory under `/home/node/.claude` should be a whole-dir mount, not per-file.



**Symptom:** When the new `superRefine` config guard landed on the VPS (commit `bd0ceb0`), `assessiq-api` entered a crash loop with `ENABLE_E2E_TEST_MINTER MUST be false in production`. Investigation revealed `/srv/assessiq/.env` line 28 had `ENABLE_E2E_TEST_MINTER=true` set in production. This means the dev-only POST `/api/dev/mint-session` route — which bypasses Google SSO + TOTP and (until commit `bd0ceb0`) accepted caller-supplied `role`, allowing any candidate to escalate to admin — had been reachable on `https://assessiq.automateedge.cloud` since the route shipped in commit `b3710ae`.

**Cause:** Two compounding errors:
1. **Dev-only env var leaked into prod `.env`.** When the route was added (`b3710ae`, `feat(e2e): full admin-to-candidate workflow spec + dev test-minter endpoint`), the corresponding `ENABLE_E2E_TEST_MINTER=true` line was set in `/srv/assessiq/.env` to make the route reachable for E2E runs against prod-like infra. There was no gate preventing the same flag from being kept on after the E2E run, and no documentation flagging it as prod-forbidden.
2. **Single line of defense.** The original mint-session.ts only had a compile-time conditional import in `apps/api/src/server.ts` as the gate. With the env flag flipped, that gate let the route register. The route then trusted the caller-supplied `role` field for `sessions.create()` (`apps/api/src/routes/dev/mint-session.ts:170` pre-fix), so any unauthenticated POST with `{role: 'admin', email: <existing-candidate-email>}` would mint an admin session for an existing candidate user.

**Fix:**
- `modules/00-core/src/config.ts:123-134` (commit `bd0ceb0`): superRefine throws when `NODE_ENV === 'production' && ENABLE_E2E_TEST_MINTER === true`. The API now refuses to boot rather than register the route in prod.
- `apps/api/src/routes/dev/mint-session.ts:171-186` (commit `bd0ceb0`): existing users now session with their DB role (caller-supplied `role` is ignored when a user exists); new-user auto-creation is restricted to `role=candidate` only.
- `apps/api/src/routes/dev/mint-session.ts:205-215` (commit `bd0ceb0`): audit write is now `await`-ed and fail-closed (was `.catch(...)` non-fatal).
- VPS recovery: `/srv/assessiq/.env` line 28 set to `ENABLE_E2E_TEST_MINTER=false`, `assessiq-api` recreated. Verified post-deploy: `GET /api/health` → 200, `POST /api/dev/mint-session` → 404 (route not registered).

**Exposure window:** From `b3710ae` deploy (~2026-05-08 evening) to `bd0ceb0` deploy (2026-05-09 ~17:18 IST). No exploit attempts visible in `/var/log/assessiq/api.log` for that path, but a full audit_log review for unexpected `dev.mint_session` actions is owed.

**Prevention:**
- Config-time gate (added) — production cannot boot with the flag on.
- Defense-in-depth at handler level (added) — caller-supplied `role` no longer trusted for existing users; new-user creation gated to `candidate`.
- Audit fail-closed (added) — every successful mint creates an audit_log row or the request fails.
- TODO: add `ENABLE_E2E_TEST_MINTER` to `lint-deploy-procedure` CHECK C as a prod-forbidden var (any mention in `/srv/assessiq/.env` other than `=false` should fail CI).
- TODO: review `audit_log` for any `dev.mint_session` rows or anomalous `session_create` rows during the exposure window.

## 2026-05-08 — lint-deploy-procedure: 4-check CI lint hardens against ops-vs-code drift

**Symptom:** Three distinct classes of "code shipped, operational dependency missed" bugs recurred across 2026-05-03 through 2026-05-08, each causing production incidents that took 1–4 hours to diagnose:
1. **Skill bind-mount missing** (2026-05-08): `prompts/skills/` commit shipped but no Docker bind-mount in `infra/docker-compose.yml` → skills invisible inside `assessiq-api` container → feature blocked.
2. **Migration apply chain gap** (chronic risk, no incident yet): SQL files committed outside `modules/<name>/migrations/<file>.sql` depth are silently skipped by `tools/migrate.ts` → schema diverges from code without any error.
3. **Env var not provisioned** (SMTP_URL, 2026-05-08): `SMTP_URL` in config schema and used in code but missing from `.env.example` → operators don't know to set it → email feature silently falls back to dev stub on production.
4. **Email template URL mismatch** (2026-05-04, RCA entry "punch-list #7"): `service.ts` built invitation links as `${PUBLIC_URL}/invite/${token}`; SPA has no `/invite/:token` route → candidates landed on 404 page.

**Cause:** All four bug classes shared the same root cause: there was no automated gate checking that code commits are operationally self-consistent. Each class was caught only after a live incident or manual test session, never at PR time.

**Fix:** `tools/lint-deploy-procedure.ts` — a new TypeScript CI lint implementing four independent checks:
- **CHECK A** (`tools/lint-deploy-procedure.ts`, `checkSkillBindMounts()`): Every `prompts/skills/<name>/SKILL.md` must have a volume mount in `infra/docker-compose.yml` for `assessiq-api` and `assessiq-worker`. Inverse check also included.
- **CHECK B** (`tools/lint-deploy-procedure.ts`, `checkMigrationApplyChain()`): Every `.sql` file under `modules/` or `apps/` that is NOT at the runner's discovery depth (`modules/<name>/migrations/<file>.sql`) must carry the `-- DEPLOY: manual; not part of migration sequence` exemption marker or be treated as an orphan.
- **CHECK C** (`tools/lint-deploy-procedure.ts`, `checkEnvVarDeclaration()`): Every `process.env.VAR_NAME` reference in source code must appear (anywhere, including comment mentions) in `.env.example`.
- **CHECK D** (`tools/lint-deploy-procedure.ts`, `checkEmailTemplateUrls()`): Every URL path constructed in email-sending service code (template literal `${base}/path/${segment}` pattern) and every hardcoded `href` in template HTML must have a matching first path segment in `apps/web/src/App.tsx`.

Wired into `.github/workflows/ci.yml` step 12 (self-test + repo scan, both required-pass). Package scripts: `pnpm lint:deploy-procedure` and `pnpm lint:deploy-procedure:self-test`. Documented in `docs/06-deployment.md` § Pre-deploy lint gates.

**Results on current main (2026-05-08):**
- CHECK A: ✓ clean (skills bind-mount fix shipped earlier today)
- CHECK B: ✓ clean (all migrations at correct depth)
- CHECK C: ✗ 9 pre-existing violations (real punch list — separate follow-up session):
  - `ASSESSIQ_PUBLIC_URL` (service.ts:85) — alternative to ASSESSIQ_BASE_URL, undocumented
  - `ASSESSIQ_DEV_EMAILS_LOG` (lifecycle.test.ts:1148) — dev-only email log path
  - `AIQ_ADMIN_USER_ID` (eval/cli.ts:609) — eval CLI admin user
  - `S3_BUCKET` (archive-job.ts:65) — audit-log archival target
  - `ENABLE_EMBED_TEST_MINTER` (embed.ts:173) — embed test gate, undocumented
  - `ENABLE_E2E_TEST_MINTER` (mint-session.test.ts:192) — in config.ts but absent from .env.example
  - `PLAYWRIGHT_BASE_URL`, `E2E_API_BASE_URL` (factories.ts) — E2E test base URLs
  - `E2E_CANDIDATE_TOKEN` (take-happy-path.spec.ts:7) — E2E fixture token
- CHECK D: ✓ clean (magic-link fix a79282c confirmed effective)

**Prevention:** The lint itself, with self-test (17 assertions) confirming all four check classes detect violations correctly. `pnpm lint:deploy-procedure:self-test` in CI ensures the lint doesn't silently regress.

## 2026-05-08 — 3 remaining 2026-05-03 punch-list bugs closed (punch-list #4, #6, #7)

**Symptom:** Three bugs from the 2026-05-03 manual-test session were not fixed in subsequent sessions:
- **#4 (invite-accept no-enumeration oracle)** — `findInvitationByTokenHashSystem` WHERE clause was `token_hash = $1 LIMIT 1`; expired and already-used tokens returned different error codes (`INVITATION_EXPIRED`, `INVITATION_ALREADY_USED`) from not-found tokens (`INVITATION_NOT_FOUND`), creating a timing-oracle that could distinguish token states.
- **#6 (pack-detail pageSize=100 vs backend cap=500)** — `pack-detail.tsx` fetched `GET /admin/questions?pageSize=100` after the backend `parsePagination()` cap was raised to 500 in commit `2431ad5`. Packs with L1/L2/L3 fully populated (200+ questions) silently truncated to 100.
- **#7 (candidate invitation URL `/invite/<token>` → `/take/<token>`)** — `inviteUsers()` in `modules/05-assessment-lifecycle/src/service.ts` built the magic-link as `PUBLIC_URL + '/invite/' + plaintext`. The SPA has no `/invite/:token` route; candidates clicking the link landed on the SPA 404 fallback. Confirmed by dev-emails.log: `2026-05-03T13:39:21.256Z` entry shows `https://assessiq.automateedge.cloud/invite/BK8_Zzw4RvL80eelEYOdMirxzVwcZmhzZrhpZ3qRrBE`.

**Cause:**
- **#4** — The `findInvitationByTokenHashSystem` SQL didn't include `AND accepted_at IS NULL AND expires_at > NOW()`. The service layer had manual post-lookup checks that threw distinct error codes, leaking oracle information. `modules/03-users/src/repository.ts` line ~443.
- **#6** — Only the backend `parsePagination()` cap was updated in the prior fix; the frontend fetch URL in `modules/10-admin-dashboard/src/pages/pack-detail.tsx` line ~140 still used `pageSize=100`.
- **#7** — `modules/05-assessment-lifecycle/src/service.ts` line 741 used `/invite/` instead of `/take/`. The `/take/:token` SPA route and the `POST /api/take/start` API endpoint are the correct candidate entry points; `/invite/` was never registered.

**Fix:**
- **#4** (`d20735a`): `findInvitationByTokenHashSystem` WHERE clause: added `AND accepted_at IS NULL AND expires_at > NOW()`. All invalid tokens (expired, used, not-found) now return null → identical `INVITATION_NOT_FOUND` 4xx. Two `users.test.ts` assertions updated from `ConflictError(INVITATION_EXPIRED/INVITATION_ALREADY_USED)` to `NotFoundError(INVITATION_NOT_FOUND)`.
- **#6** (`51a1ad1`): `pack-detail.tsx` fetch: `pageSize=100` → `pageSize=500`. Questions error card (danger border + Retry) was already present.
- **#7** (`a79282c`): `service.ts` line 741: `/invite/` → `/take/`. Regression test added to `modules/13-notifications/src/__tests__/notifications.test.ts`: renders `invitation_candidate` template; asserts body contains `/take/<token>` and does not contain `/invite/`.

**Prevention:**
- The no-enumeration oracle (Fix #4) is now enforced at the DB layer — the service manual checks are dead code but harmless. Any future lookup that needs to distinguish expired-vs-used states must do so via audit log, not via distinct API error codes visible to the caller.
- Paginated fetch URLs should always match the backend cap; the RCA for #6 (`2026-05-04 — GET /api/admin/questions 400`) should have updated the frontend too.
- The Fix #7 regression test in `notifications.test.ts` guards the template contract permanently: `/invite/` in a candidate invitation email is a test failure.

## 2026-05-08 — 6 workflow-integration bugs caught by manual click-testing; E2E spec added as recurrence prevention

**Symptom:** Manual click-testing on 2026-05-08 surfaced 6 bugs in 2 hours, of which 3–4 were workflow-integration-class regressions (involving cross-module state transitions, empty-state handling, and invitation acceptance errors) that could have been caught by automated E2E tests at PR time. Specific bugs referenced by their prior RCA entries: `POST /admin/packs 500 slug null` (baf73cb), `GET /admin/questions 400 pageSize cap` (2431ad5), `POST /invitations/accept 500 withSystemClient` (30ba73d), and cohort-report empty-state blank page.

**Cause:** No automated E2E spec existed for the full admin→candidate workflow. Unit tests and integration tests validated individual modules in isolation but did not cover the multi-step workflow sequence (pack → questions → activate → publish pack → create cycle → publish cycle → invite → take → grade → view report). Cross-module state transitions (e.g. "questions must be activated after publishing pack before an assessment can be published") were only validated by the developer's mental model during development, not by automated assertions.

**Fix (2026-05-08):** Added three new files:
- `apps/api/src/routes/dev/mint-session.ts` — dev-only POST /api/dev/mint-session, env-gated via `ENABLE_E2E_TEST_MINTER=true`. Creates real sessions without Google SSO. NOT registered in production (compile-time skip via conditional import in `server.ts`). Audits every mint to `audit_log` with `action='dev.mint_session'`.
- `apps/web/e2e/fixtures/factories.ts` — Node.js fetch helpers for all E2E setup/teardown operations (mintAdminSession, mintCandidateSession, createPack, addLevel, createMcqQuestion, createSubjectiveQuestion, publishPack, activateAllQuestionsForPack, createAssessment, publishAssessment, inviteCandidate, startAttempt, answerQuestion, submitAttempt, triggerGrading, acceptGradings, cleanupTestData).
- `apps/web/e2e/admin-workflow.spec.ts` — 13-step serial Playwright E2E spec covering the full admin→candidate workflow. Each step asserts HTTP success on the relevant API call, no "Not found." or raw error string in the DOM, and no unexpected console errors.

**Prevention:** The `admin-workflow.spec.ts` spec is the permanent recurrence prevention for the workflow-integration-class regression pattern. It runs on every PR when `vars.E2E_BASE_URL` is configured in the GitHub repo settings (see `.github/workflows/ci.yml` `e2e` job). Future workflow-integration changes must not break this spec.

The spec guards specifically against:
- Pack creation 500 (step 03) — catches the slug null-constraint class
- Questions not loading in pack detail (step 03b) — catches the pageSize cap class
- Invitation acceptance 500 (step 10/11) — catches the withSystemClient pre-auth path class
- Cohort report blank page (step 13) — catches empty-state rendering failures

---

## 2026-05-04 — GET /api/admin/questions 400 "pageSize must be between 1 and 100"

**Symptom:** Pack-detail page returned a raw error string "pageSize must be between 1 and 100" at `2026-05-03T22:00:28Z`. Admin could not view questions for any pack.

**Cause:** `parsePagination()` in `modules/04-question-bank/src/routes.ts` capped `pageSize` at 100. The pack-detail frontend requested `pageSize=200` to load all questions for a pack in one shot (so they can be grouped by level client-side). The cap was copied from `admin-users.ts` where 100 is intentional; for questions, 200+ per pack is normal at scale (L1/L2/L3 populated). Additionally, pack fetch and questions fetch ran in `Promise.all`, so a questions-only error surfaced as the entire page error with no Retry affordance.

**Fix (commit `2431ad5`):**
- `parsePagination()` upper bound raised from 100 → 500 with a comment explaining why the question-bank cap differs from the user-list cap.
- `pack-detail.tsx` splits the pack fetch from the questions fetch: pack errors still gate the full page; questions errors show a styled error card (danger border, "Couldn't load questions", detail text, Retry button).
- Frontend `pageSize=200` bumped to `pageSize=500` to match the new cap.

**Prevention:**
- Pagination caps shared across endpoints via a single helper function should be documented with per-endpoint rationale. Endpoints that load full-pack datasets are not the same use case as paginated user lists.
- Error states from secondary fetches should never propagate as the primary page error — split `Promise.all` into sequential fetches when the two calls have different criticality.

---

## 2026-05-04 — POST /api/admin/packs 500 "null value in column slug"

**Symptom:** Two consecutive pack-create attempts by `manishjnvk@gmail.com` at `2026-05-03T22:00:15Z` and `2026-05-03T22:00:53Z` returned HTTP 500 with Postgres error: `null value in column slug of relation question_packs violates not-null constraint`.

**Cause:** `CreatePackInput.slug` was typed as required (`slug: string`) but the admin UI never sent it — the field was not present in the request body. In `createPack()`, `assertValidSlug(input.slug)` was called before the DB insert. `SLUG_REGEX.test(undefined)` in JavaScript coerces `undefined` to the string `"undefined"` which matches `/^[a-z0-9-]{3,80}$/` (9 lowercase letters, in range). Validation therefore passed silently and `undefined` was forwarded to `insertPack()`, which sent it as `NULL` to Postgres — violating the `NOT NULL` constraint with a 500.

**Fix (commit `baf73cb`):**
- `CreatePackInput.slug` is now `optional` (`slug?: string`)
- `createPack()` auto-generates a URL-safe slug from `input.name` using NFKD normalisation + lowercase + strip `[^a-z0-9\s-]` + hyphenate + 64-char cap
- All-emoji / all-punctuation names (empty result) throw `ValidationError INVALID_NAME_FOR_SLUG`
- Collision retry: appends `-2` … `-10` suffix on Postgres `23505`; throws `ConflictError PACK_SLUG_EXISTS` after 10 attempts
- Explicit slug provided: same `assertValidSlug` + single-attempt behaviour as before
- 5 regression tests added; 60/60 pass

**Prevention:**
- API boundary inputs that are "required in DB but optional in UX" must have an auto-derive fallback at the service layer, not just a type-level assertion
- `SLUG_REGEX.test(undefined)` returns `true` because of JS coercion — any regex validator applied to a potentially-undefined TypeScript optional must guard with `if (value !== undefined && value.trim().length > 0)` before testing
- CLAUDE.md rule #5 (same-PR docs): `docs/03-api-contract.md` and `modules/04-question-bank/SKILL.md` updated in this commit

**Recurrence weight:** First instance of the JS-regex-coercion-of-undefined class. Guardrail: future slug/identifier validations in service.ts should use `if (input.slug !== undefined && input.slug.trim())` guards, not bare `SLUG_REGEX.test(input.slug)` calls.



**Symptom:** `pnpm lint:ambient-ai` exited 1 immediately after Opus added a load-bearing comment to `modules/07-ai-grading/src/runtime-selector.ts` warning the Session 1.b author about an eager-import startup hazard. The lint had passed cleanly two minutes earlier; the only intervening change was the new comment.

**Cause:** The new comment quoted the literal SDK import line so a future reader could grep for it (`import { query } from "@anthropic-ai/claude-agent-sdk"`). The lint's Pattern 2 regex `RE_AGENT_SDK_IMPORT` at `modules/07-ai-grading/ci/lint-no-ambient-claude.ts:173-174` matches the substring `from "@anthropic-ai/claude-agent-sdk"` anywhere in the file's text — it does not strip comments. `runtime-selector.ts` is not in `SDK_IMPORT_ALLOW_LIST` (only `runtimes/anthropic-api.ts` is), so the substring tripped Pattern 2 in a non-allow-listed file.

**Fix:** Rewrote the comment to describe the import without quoting the literal package path. See `modules/07-ai-grading/src/runtime-selector.ts:14-27` (committed in `7eea75b`). The lint went green again on the next run.

**Prevention:** This is the lint working correctly — text search makes no distinction between code and comments, and a "grace period for comments" would be a real evasion (any spawn could be hidden behind a `// const claude_=` prefix or a `/* */` wrap). Manual discipline: documentation that needs to reference the SDK import path or `claude` spawn site should phrase it descriptively ("the Agent SDK import in runtimes/anthropic-api.ts", "the spawn site in claude-code-vps.ts") rather than quoting the literal package or command. No lint change warranted; the failure is loud and fast.

**Recurrence weight:** First instance. If this happens again with a different load-bearing comment, escalate to a `// lint-allow-comment-quote: <reason>` pragma + lint exception — but only after a second occurrence proves the manual-discipline floor is too low.

## 2026-05-03 — preventive guardrails added: edge-routing lint + shared-mount sed hook

**Symptom:** Not an incident — this entry is the prevention layer for two RCA-pattern classes that have together produced **five** real incidents in 4 days (well past the "three is a trend, four would be process failure" threshold from RCA 2026-05-03 § Caddy `@api` matcher missing `/take/*`). Every prior prevention section in this log filed both classes as "manual discipline backed by this RCA's existence" or "Phase-2 infra-backlog item." That manual-discipline budget was spent. This session converts the backlog items into shipped tooling.

**Cause classes hardened against:**

1. **Bare-root route mount fallthrough** — modules registering Fastify routes outside the `/api/*` prefix (intentional design — `/help/*`, `/embed*`, `/take/start` for embed-friendly + magic-link short URLs) become unreachable from Cloudflare/Caddy when the AssessIQ block's `@api path` matcher is not updated in the same deploy. Two real incidents:
   - `2026-05-02 — Caddy /help/* not forwarded` (anonymous embed help endpoint fell through to SPA).
   - `2026-05-03 — Caddy @api matcher missing /take/*` (magic-link routes fell through to SPA — second occurrence in 24 hours).
   Both prevention sections explicitly recommend `tools/lint-edge-routing.ts`. Filed as backlog three times in this log.

2. **Bind-mount inode trap from in-place editors** — `sed -i` (and `awk -i inplace`, `perl -pi`, `ruby -pi`, `python -m fileinput -i`) write a temp file then rename it over the original, producing a **new** inode. Single-file Docker bind mounts capture the inode at mount time, so the running container keeps reading the OLD inode (which still exists because the mount holds an open FD even after the directory entry is overwritten). Three real incidents on this VPS:
   - `2026-04-30 — CF Origin Cert paste artifact silently failed openssl x509 parse` (introduced the inode rule with explicit comments at the top of the Caddyfile).
   - `2026-05-02 — Caddy /help/* not forwarded` (used the **correct** truncate-write procedure — pattern model for the recovery).
   - `2026-05-03 — sed -i on the bind-mounted Caddyfile broke the inode binding` (rule was forgotten despite being on disk; required `ti-platform-caddy-1` restart with explicit user approval per CLAUDE.md rule #8).
   Three occurrences in 4 days. The latest RCA's prevention #1 said verbatim: "The next prevention step is HOOK-level: add a pre-commit / pre-tool guard that refuses `sed -i` against any path under `/opt/ti-platform/caddy/`."

**Fix — shipped this session:**

1. **`tools/lint-edge-routing.ts`** — TypeScript lint, structurally cloned from `tools/lint-rls-policies.ts`. Walks `apps/api/src/server.ts` plus any `apps/api/src/routes/*.ts` and `modules/*/src/{routes,*-routes,*.routes}*.ts` files for `app.<verb>("/<path>", ...)` and `app.route({ method, url })` registrations. Reads the canonical `@api path ...` line from `docs/06-deployment.md` § "Current live state" (so the lint stays in lockstep with whatever's actually deployed — no hardcoded-list duplication). For each non-`/api/*` mount, asserts coverage via either a full Caddy path-match (`/foo/*`, `/foo*`, exact `/foo`) **or** a first-segment overlap with any matcher entry (so `GET /take/:token` is OK when `/take/start` is in the matcher — the codified intent is that the `/take/` segment is intentionally split between API and SPA). Self-test ships 7 fixtures including a regression guard for the 2026-05-03 `/take/*`-missing case. Wired into `.github/workflows/ci.yml` step 9c (self-test + repo scan, both required-pass) and `pnpm lint:edge-routing` / `pnpm lint:edge-routing:self-test` package scripts.

2. **`.claude/hooks/no-sed-shared-mount.sh`** — Bash PreToolUse hook on the Bash tool, structurally cloned from `.claude/hooks/precommit-gate.sh`. Reads tool-input JSON via stdin, extracts `.tool_input.command`. Two-phase AND check: (a) command contains an in-place editor invocation (`sed -i`, `awk -i inplace`, `perl -pi`, `ruby -pi`, `python -m fileinput -i`); (b) command targets a path under a shared-mount root (`/opt/ti-platform/`, `/etc/`, plus `/srv/`, `/var/log/`, `/var/backups/` excluding their `assessiq` sub-namespaces). Both must match → exit 2 (block). Stderr message cites all three RCA dates and shows the truncate-write recovery procedure. Override mechanism: `ALLOW_SHARED_MOUNT_SED=1 <command>` prefix passes through (escape hatch for genuinely necessary in-place edits, must be added intentionally). Wired into `.claude/settings.json` PreToolUse Bash hooks array, after the existing `precommit-gate.sh` (cheaper checks first).

**Why now (vs. earlier):** the manual-discipline gate has fired three times for the inode trap and twice for edge-routing. Each prior RCA closed with "future infra-backlog item." Those tickets paid out at zero — the next session always read the doc, the next session next still re-tripped the trap. Hook-level enforcement is the only mechanism that survives author churn. Per global CLAUDE.md Phase 2 hard rule: "Prefer wiring these as a `PreToolUse` hook on `git commit` (via `/update-config`) so the gate is harness-enforced, not discipline-dependent" — same principle applies to the inode trap.

**Considered and rejected:**

(a) **Lint-edge-routing as a warning-only step.** Rejected. The user's brief explicitly forbids it: "Lint that only WARNS instead of FAILS for Deliverable 1 — must fail CI to actually prevent recurrence." Warnings have a 100% ignore rate over time; the only mechanism that prevents the third incident is exit-1 in CI.

(b) **Hardcoding the canonical `@api path` list inside the lint.** Rejected. The matcher is documented in `docs/06-deployment.md` § "Current live state" and that doc is the source of truth for what's deployed; duplicating the list inside the lint creates a drift surface where the lint and the doc disagree. The lint reads the doc.

(c) **Shared-mount hook as log-only, allow-by-default.** Rejected per the user's brief: "Hook that only logs without blocking for Deliverable 2 — must block by default." Log-only would be even weaker than manual discipline (the log is invisible until you go looking).

(d) **Static-analysis-only edge-routing parser using a TypeScript AST library.** Considered for accuracy on `app.route({ method, url })` object-style registrations. Rejected because: (i) introduces a dependency on `@typescript-eslint/parser` or `ts-morph` solely for this lint, (ii) `tools/lint-rls-policies.ts` uses regex-on-text and is the project pattern, (iii) the regex approach handles the four real-world idioms in this codebase (string-arg, object-with-`url`, route-prefix-via-register, and `app.route` with method-array). Future module patterns that bypass this (e.g. dynamic route construction at runtime) will need the lint to be extended; that's an acceptable cost.

(e) **Linting from inside `precommit-gate.sh` instead of CI.** Rejected. Edge-routing lint needs to scan the whole route surface, not just the staged diff — a pre-commit only sees what's changing in this commit, but the violation is "is the *current* matcher coverage complete given the *current* mount set," which is an invariant of the whole tree. CI is the right enforcement layer; the precommit-gate's job is fast diff-only checks (secrets, ambient-AI calls).

(f) **Restricting the `no-sed-shared-mount` hook to only `/opt/ti-platform/caddy/Caddyfile`.** Considered as the narrowest possible block surface. Rejected because the inode trap class extends to any single-file bind mount on the shared VPS (and `/etc/` configs reloaded by long-running daemons follow an analogous pattern even when not bind-mounted). Broadening to all of `/opt/ti-platform/`, `/etc/`, and the non-assessiq sub-trees of `/srv`, `/var/log`, `/var/backups` covers the trap class without adding false positives — the user's own `assessiq` sub-trees are explicitly carved out.

**NOT included:**

- A linter or hook that touches the running VPS itself. Both deliverables are local — the lint is a dev/CI gate, the hook is a Claude Code PreToolUse guard. Per CLAUDE.md rule #8 the VPS gets only additive deploys; this session ships zero deploys.
- Modification of `modules/07-ai-grading/ci/lint-no-ambient-claude.ts`. That file is in the load-bearing-paths list and out of scope per the user's brief.
- A docker-closure linter (`tools/lint-docker-closure.ts`) recommended by RCA `2026-05-03 — assessiq-frontend Docker build TS2307 cascade`. Different RCA pattern class (Dockerfile workspace closure vs. edge-routing matcher); deferred to a future session.
- An ESLint rule against `expect(() => ...).toSatisfy(predicate)` for thrown-error assertions (recommended by RCA `2026-05-02 — vitest toSatisfy on thunk`). Different RCA pattern class; deferred.
- Migration of the existing `precommit-gate.sh` checks into the new hook. The two hooks have separate scopes (commit-time vs. arbitrary-bash-time) and run in sequence; merging would couple them unnecessarily.

**Downstream impact:**

- Phase 3 critique sections of future sessions can reference `lint-edge-routing` and `no-sed-shared-mount` as "this is the layer that catches it now" rather than re-deriving the manual rule from prior RCAs.
- Module SKILL.md files for any future module that mounts non-`/api/*` routes (analogous to module 16's `/help/*` and module 06's `/take/start`) can omit the "remember to update Caddy matcher" reminder; CI will catch it.
- The `docs/06-deployment.md` § "Current live state" canonical Caddyfile snippet now has an additional load-bearing role: it is the source of truth that `lint-edge-routing` reads. Future edits to that snippet flow through to lint coverage automatically.
- The `ALLOW_SHARED_MOUNT_SED=1` override remains available for the rare case where in-place edit on a shared path is genuinely needed (e.g., emergency recovery where truncate-write isn't available); use of it should be paired with a comment explaining why and a smoke-check that the bind-mounted container actually picked up the change.

**Cross-reference:** `tools/lint-edge-routing.ts` (new, 671 lines), `.claude/hooks/no-sed-shared-mount.sh` (new), `.github/workflows/ci.yml` step 9c (CI wiring), `.claude/settings.json` PreToolUse Bash hooks (hook wiring), `docs/06-deployment.md` § "Current live state" (canonical matcher snippet, also updated this session to include `/take/start`). Prevented incidents: 2026-05-02 `/help/*` fallthrough, 2026-05-03 `/take/*` fallthrough, 2026-04-30 + 2026-05-02 + 2026-05-03 inode-trap occurrences.

## 2026-05-03 — `assessiq-api` restart loop from staggered take-backend deploy (`registerAttemptTakeRoutes` import broke before module 06 source landed)

**Symptom:** Production `assessiq-api` container in `Restarting (1)` loop. `docker logs` showed:

```
SyntaxError: The requested module '@assessiq/attempt-engine' does not provide an export named 'registerAttemptTakeRoutes'
    at /app/apps/api/src/server.ts:17
```

The `apps/api/src/server.ts` line 17 import was already deployed by an earlier session (commit `a7053b7` referenced this in its handoff), but the matching export from `modules/06-attempt-engine/src/index.ts` (re-exporting `registerAttemptTakeRoutes` from the new `routes.take.ts` file) was NOT deployed in the same window. The container would boot, fail import resolution, exit non-zero, and Docker `restart: unless-stopped` would loop it. The frontend stayed healthy on port 9091 and the worker stayed healthy on Redis, so external traffic to `/api/*` returned 502 from Caddy while the rest of the surface looked normal.

**Cause:** Two separate concurrent windows working on the same end-to-end ship (Phase 1 G1.D candidate-ui + Session 4b take-backend) produced an artifact-only deploy where the **importer** landed before the **export it depended on**. The `apps/api/src/server.ts` change was bundled into commit `a7053b7` (G1.D + worker handoff session) and that commit's deploy procedure wrote `apps/api/src/` to `/srv/assessiq/` but did NOT include `modules/06-attempt-engine/src/routes.take.ts` or the updated `index.ts` re-export. The pnpm workspace symlink at `/srv/assessiq/apps/api/node_modules/@assessiq/attempt-engine` resolves to the on-disk `modules/06-attempt-engine/src/index.ts`; that file at the deploy moment did not yet have the re-export, so Node ESM threw `SyntaxError` on the import.

**Fix:** Pushed the missing files via `git archive HEAD modules/05-assessment-lifecycle/src/index.ts modules/05-assessment-lifecycle/src/service.ts modules/06-attempt-engine/src/index.ts modules/06-attempt-engine/src/routes.take.ts ... | ssh assessiq-vps "cd /srv/assessiq && tar -xf -"`. Then `docker compose build assessiq-api && up -d --force-recreate assessiq-api`. Container went from restarting → `(healthy)` within 20s. Health endpoint `/api/health` returned 200 on first request after recovery.

**Prevention:**

1. **Process rule — atomic deploys for cross-module changes.** When a deploy includes a server.ts import that references a new module export, the `git archive HEAD` invocation MUST list BOTH the importer and the exporter file paths. Bare `apps/api/src/...` deploys are correct for apps/api-only changes; cross-module changes need `apps/api/src/... modules/<n>/src/...` together. Treat "deploy includes server.ts import addition" as a Phase 3 bounce condition: the deploy diff must include the matching module's `index.ts` AND the new source files in the same archive call.
2. **Process rule — verify the export resolves before declaring deploy done.** After any `assessiq-api` container recreate, the smoke checklist must include a 5-second log scrape: `docker logs --tail 20 assessiq-api 2>&1 | grep -i 'syntaxerror\|module.*does not provide'`. If anything matches, the deploy is broken and a follow-up file push is needed BEFORE moving to other smoke steps. Add to `docs/06-deployment.md` § Operational recipes when that section grows.
3. **Cross-window coordination** — the W4+W5 working-tree-stall RCA from 2026-05-01 already calls out parallel-session collisions on the same module-graph segment as the root cause of multi-hour triages. This incident is the artifact-only-deploy variant of the same pattern: two windows shipped the same logical change, one window's commit was deploy-ready but missing pieces from another window's commit. Until per-session worktrees are normalized, the smoke-check above is the load-bearing safeguard. Recorded here so the pattern doesn't surprise the next session.

**Cross-reference:** RCA 2026-05-01 § "W4+W5 working-tree stall: 30+ uncommitted files across two parallel sessions". `docs/06-deployment.md` smoke checklist needs the log-scrape addition. Commit `fae4b33` (the take-backend module 06 export) and commit `a7053b7` (the apps/api importer that referenced it) document the staggered shipping that produced the 502.

## 2026-05-03 — `sed -i` on the bind-mounted Caddyfile broke the inode binding — running Caddy stuck on stale config

**Symptom:** After narrowing the `@api` matcher from `/take/*` to `/take/start` (so `GET /take/<token>` would fall through to the SPA frontend), `caddy reload` reported `Valid configuration` but the running Caddy continued routing all `/take/*` to `assessiq-api`. `docker exec ti-platform-caddy-1 caddy adapt --config /etc/caddy/Caddyfile` showed the JSON config still had `/take/*` even though the on-disk Caddyfile had `/take/start`. Multiple `caddy reload` invocations did not pick up the change.

**Cause:** The narrowing edit used `sed -i 's|...|...|' /opt/ti-platform/caddy/Caddyfile`. `sed -i` does NOT edit in place at the original inode — it writes the new content to a temporary file and **renames** it over the original, producing a NEW inode. `stat` confirmed the inode changed from `4194305` (original at session start) to `4194330` (after `sed -i`).

The `ti-platform-caddy-1` container bind-mounts the single file `/opt/ti-platform/caddy/Caddyfile` to `/etc/caddy/Caddyfile`. Single-file Docker bind mounts capture the **inode at mount time**, not the path. When the source file is replaced via rename (the `sed -i` mechanic), the container continues to see the OLD inode (which still exists because the mount holds an open reference even after the host directory entry was overwritten). The container therefore reads stale config every time `caddy adapt` re-reads `/etc/caddy/Caddyfile`.

This is the **second** occurrence of the inode trap on this VPS. RCA 2026-04-30 (CF Origin Cert paste) introduced the rule "**Edits MUST use truncate-write (`cat new > file`), NEVER mv — bind-mount inode trap**" with explicit comments at the top of `/opt/ti-platform/caddy/Caddyfile`:

```
# Edits MUST use truncate-write (cat >), NEVER mv — bind-mount inode trap
# from RCA 2026-04-30.
```

The earlier `/help/*` matcher add (RCA 2026-05-02) followed the rule correctly with `sed pattern file > tmp; cat tmp > file`. This session's narrowing edit used `sed -i` and bypassed the rule.

**Fix:** With explicit user approval (per CLAUDE.md AssessIQ rule #8 — STOP before docker rm/stop of non-`assessiq-*` containers), restarted `ti-platform-caddy-1`. Caddy on restart re-bound to the current inode (4194330) and picked up the narrowed `/take/start` matcher. Verified via `docker exec ti-platform-caddy-1 caddy adapt`: matcher list now `["/api/*", "/embed*", "/help/*", "/take/start"]`. Smoke confirmed `GET /take/<token>` returns `200 text/html` (SPA) and `POST /take/start` returns the API JSON envelope. Other 4 sites on the shared Caddy (intelwatch.in / ti.intelwatch.in / accessbridge.space / automateedge.cloud) all unaffected — restart was ~1s graceful.

**Prevention:**

1. **NEVER use `sed -i` on bind-mounted files.** The disk has the comment, the RCA log has the rule, and yet the trap fired again. The next prevention step is HOOK-level: add a pre-commit / pre-tool guard that refuses `sed -i` against any path under `/opt/ti-platform/caddy/`. Recorded as a Phase-2 infra-backlog item; until then, the rule is "manual discipline backed by this RCA's existence."
2. **Always validate the running config matches disk after a Caddyfile edit.** Compare `docker exec ti-platform-caddy-1 caddy adapt --config /etc/caddy/Caddyfile` JSON against the on-disk Caddyfile after every reload; mismatch = inode trap fired and reload was a no-op. The 1-line check:

   ```bash
   ssh assessiq-vps "diff <(grep '@api path' /opt/ti-platform/caddy/Caddyfile) <(docker exec ti-platform-caddy-1 caddy adapt --config /etc/caddy/Caddyfile 2>/dev/null | grep -A4 '@api path' | head -10)"
   ```

   If diff is non-empty, the disk has changes the container can't see. Restart Caddy to recover.
3. **Recovery procedure documented:** restoring from inode-trap requires a Caddy container restart (single-file bind mounts are not "follow path" in Docker). The restart is graceful (~1s) and affects all sites on the shared host. Per CLAUDE.md rule #8, restart of `ti-platform-caddy-1` MUST have explicit user approval — this is a shared-infra mutation, not an `assessiq-*` operation.

**Cross-reference:** RCA 2026-04-30 § "CF Origin Cert paste artifact silently failed openssl x509 parse" introduced the inode rule; RCA 2026-05-02 § "Caddy `/help/*` not forwarded" demonstrated the correct truncate-write procedure. This is the third Caddyfile-bind-mount-related entry in 4 days; the next instance should escalate to the prevention-hook backlog item.

## 2026-05-03 — Caddy `@api` matcher missing `/take/*` — magic-link routes fell through to SPA

**Symptom:** Phase 1 G1.D + Session 4b.2 magic-link `/take/:token` routes returned `200 text/html` (the SPA `index.html`) instead of the expected `404 INVITATION_NOT_FOUND` JSON envelope when hit through the public hostname. Direct testing inside the `assessiq-api` container against `127.0.0.1:3000/take/<token>` correctly returned the JSON 404 envelope and the route was logged with `route":"/take/:token"` in the request log — meaning the API had the routes registered and was responding correctly. The gap was purely edge routing.

**Cause:** The `@api` matcher in the shared `/opt/ti-platform/caddy/Caddyfile` (assessiq.automateedge.cloud block) was `@api path /api/* /embed* /help/*`. The `/take/*` bare-root path that `registerAttemptTakeRoutes` mounts (intentionally without an `/api` prefix — magic-link URLs go in candidate emails and short paths are easier to read / less spam-flagged) was not in the matcher. Caddy's default `handle { reverse_proxy ... 9091 }` routed the request to `assessiq-frontend`, where the SPA's catch-all served the index.html. This is structurally identical to the `/help/*` RCA from 2026-05-02 — same matcher, same surface, same edit procedure.

**Fix:** Inode-preserving truncate-write of the Caddyfile to add `/take/*` to the `@api` matcher:

```caddy
@api path /api/* /embed* /help/* /take/*
```

Procedure (preserves bind-mount inode per the RCA 2026-04-30 lesson):

```bash
TS=$(date -u +%Y%m%d-%H%M%S)
cp /opt/ti-platform/caddy/Caddyfile /opt/ti-platform/caddy/Caddyfile.bak.$TS
stat -c %i /opt/ti-platform/caddy/Caddyfile  # capture before
sed 's|@api path /api/\* /embed\* /help/\*|@api path /api/* /embed* /help/* /take/*|' \
  /opt/ti-platform/caddy/Caddyfile > /tmp/Caddyfile.new
cat /tmp/Caddyfile.new > /opt/ti-platform/caddy/Caddyfile
stat -c %i /opt/ti-platform/caddy/Caddyfile  # confirm unchanged
docker exec ti-platform-caddy-1 caddy validate --config /etc/caddy/Caddyfile
docker exec ti-platform-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

After reload: `/take/<token>` returns `404 INVITATION_NOT_FOUND`; `POST /take/<token>/start` returns the same envelope (token doesn't exist). Regression check: `/`, `/api/health`, `/help/*`, `ti.intelwatch.in/`, `accessbridge.space/` all unchanged.

**Prevention:**

1. **Pattern guard for any module that mounts non-`/api/*` routes.** The Phase 1 G1.A help-system RCA (2026-05-02 § Caddy `/help/*` not forwarded) established this pattern; this incident is the second occurrence in 24 hours. Any module that mounts a `app.get("/<x>"...)` or `app.post("/<x>"...)` whose path does NOT start with `/api/` MUST update the Caddy `@api` matcher in the same deploy. Add to module SKILL.md `## Edge routing` sections.
2. **Phase 5 deploy smoke MUST include every public bare-root path.** The Session 4b.2 deploy procedure listed `curl /api/health → 200` and `/api/me/* → 401` but did NOT list `curl /take/<fake-token>`. The route smoke for module 06 should be:

   ```bash
   # Mounted under /api/* (via @api matcher):
   curl https://assessiq.automateedge.cloud/api/me/assessments       # 401
   # Mounted at bare-root /take/* (REQUIRES @api matcher entry):
   curl https://assessiq.automateedge.cloud/take/INVALID_TOKEN_LONG_ENOUGH_FOR_MIN_LEN_GATE
   #   expect: 404 + {"error":{"code":"INVITATION_NOT_FOUND",...}}
   #   if 200 + HTML  → @api matcher is missing /take/*
   ```

3. **Future `tools/lint-edge-routing.ts`** would parse `apps/api/src/server.ts` for non-`/api/*` route mounts (transitively through registered route plugins) and assert every bare-root path is in the canonical Caddyfile matcher snippet stored in `docs/06-deployment.md`. Recorded as a Phase-2 infra-backlog item (same recommendation as the help-system RCA).

**Cross-reference:** RCA 2026-05-02 § "Caddy `/help/*` not forwarded — anonymous embed help endpoint fell through to SPA" — identical root-cause pattern; this is the second instance. Three is a trend; four would be a process failure.

## 2026-05-03 — `assessiq-frontend` Docker build TS2307 cascade after Phase 1 G1.D module additions

**Symptom:** During Phase 1 G1.D deploy, `docker compose build assessiq-frontend` failed with 9 TypeScript errors:

- `TS2307: Cannot find module '@assessiq/candidate-ui' or its corresponding type declarations` (TokenLanding.tsx, Submitted.tsx, Attempt.tsx)
- `TS2307: Cannot find module '@assessiq/help-system/components'` (TakeRoot.tsx)
- 7 × `TS18046: 'err' is of type 'unknown'` (TokenLanding.tsx + Attempt.tsx catch blocks)

The TS18046 errors were CASCADING noise — `useUnknownInCatchVariables: true` (default under `strict: true`) requires narrowing on `catch (err)` blocks before accessing `err.status`. The narrowing IS present (`if (err instanceof CandidateApiError) ...`) but TS treats `CandidateApiError` as `any` when the import resolution fails, so the narrowing erases. Identical local typecheck (`pnpm --filter @assessiq/web typecheck`) had passed — the missing modules were only absent in the **Docker build context**, not on disk.

**Cause:** Two-layer filtering issue.

1. **`infra/docker/assessiq-frontend/Dockerfile`** copies workspace package metadata one module at a time in the `deps` stage and source in the `builder` stage. It only listed `apps/web` and `modules/17-ui-system`. Phase 1 G1.D added `@assessiq/candidate-ui` and `@assessiq/help-system` as workspace deps of `apps/web` (in `apps/web/package.json` commit `da62760`), and `@assessiq/help-system` transitively pulls `@assessiq/{core, tenancy}`. None of those four were in the Dockerfile's COPY list.
2. **`infra/docker/assessiq-frontend/Dockerfile.dockerignore`** (a per-Dockerfile dockerignore introduced earlier — BuildKit 1.7+ honors it INSTEAD OF the repo-root `.dockerignore`) had explicit excludes for `modules/{00-core, 01-auth, 02-tenancy, 03-users, 04-question-bank, 13-notifications, 16-help-system}` — which would have stripped them from the build context even if the Dockerfile had COPY'd them.

The two layers compounded: the COPY missed them AND the dockerignore would have hidden them.

**Fix:** Two coordinated edits in commit `93a9e50`:

1. `Dockerfile` — added COPY for `modules/{00-core, 02-tenancy, 11-candidate-ui, 16-help-system}` package.json in the `deps` stage and full source tree in the `builder` stage. Both stages preserve cache-layer ordering: package.json copies before `pnpm install`; source copies after.
2. `Dockerfile.dockerignore` — replaced the blanket exclude block with an allowlist matching the @assessiq/web workspace closure (`{00-core, 02-tenancy, 11-candidate-ui, 16-help-system, 17-ui-system}`) and explicit excludes for the rest of the Phase 1 server-side modules (`{01-auth, 03-users, 04-question-bank, 05-assessment-lifecycle, 06-attempt-engine, 07-ai-grading, 08-rubric-engine, 09-scoring, 10-admin-dashboard, 12-embed-sdk, 13-notifications, 14-audit-log, 15-analytics}`). Comment block calls out the closure rationale so future module additions are obvious.

After the two edits + `docker compose build` + `up -d --no-deps --force-recreate assessiq-frontend`: image built clean (Vite output `dist/assets/index-DnhSiNoW.js   386.60 kB │ gzip: 121.19 kB`), container healthy in <15 s, smoke tests `/take/INVALID_TOKEN`, `/take/expired`, `/take/error`, `/api/health` all returned `200`. 14 co-tenant containers untouched.

**Prevention:**

1. **Pattern guard for any new workspace dep added to apps/web:** the FIRST commit that adds a `workspace:*` dep MUST also include the corresponding COPY lines in `infra/docker/assessiq-frontend/Dockerfile` AND any necessary changes to `infra/docker/assessiq-frontend/Dockerfile.dockerignore`. Same rule applies to any other Dockerfile that filters its workspace closure manually (`infra/docker/assessiq-api/Dockerfile`, `apps/worker/Dockerfile` if/when it grows). Add a checklist row to module SKILL.md "Status" sections for any module that becomes a workspace dep of a built image.
2. **`pnpm --filter @assessiq/web typecheck` is NOT a substitute for `docker compose build`** when the diff adds new workspace deps. Local typecheck reads the actual file system; Docker build reads the filtered context. The two diverge whenever a Dockerfile / dockerignore needs updating. **Recommended addition to Phase 2 deterministic gates:** if `git diff` touches `apps/web/package.json` or `pnpm-lock.yaml` (entries under `apps/web` or `modules/`), trigger a `docker compose build assessiq-frontend` smoke as part of the Phase 2 gate sweep. Same rule for the API Dockerfile when backend module deps change.
3. **TS18046 cascading from TS2307 is a known-loud-but-noisy pattern** — when seeing TS18046 errors on `catch (err)` blocks where the narrowing IS clearly correct, look UPSTREAM for TS2307 first. The `useUnknownInCatchVariables` lint behaves as if the imported type is `any` when the import resolution fails. Future Phase 3 critique should flag "TS18046 + TS2307 in same diff" as the trigger to re-check Dockerfile workspace closure.
4. **No automatic enforcement is feasible today** — there is no lint that knows the relationship between `apps/web/package.json`'s workspace deps and the Dockerfile's COPY closure. A future `tools/lint-docker-closure.ts` could parse both and assert COPY coverage; recorded for the future-infra backlog.

**Cross-reference:** commit `da62760` (Phase 1 G1.D code), commit `93a9e50` (this fix), `infra/docker/assessiq-frontend/Dockerfile`, `infra/docker/assessiq-frontend/Dockerfile.dockerignore`, `modules/11-candidate-ui/SKILL.md` § Status banner.

## 2026-05-02 — `publishPack` version bump leaves attempt_questions JOIN empty when pinning to `questions.version`

**Symptom:** Phase 1 G1.C Session 4a integration tests failed in 6 of 18 cases — every test that relied on `getAttemptForCandidate` or any downstream function that resolves the frozen question set returned `view.questions.length === 0`. The failure cascaded as `TypeError: Cannot read properties of undefined (reading 'question_id')` on `view.questions[0]!.question_id`. The earliest failing case was `startAttempt > happy path`, where `repo.listFrozenQuestionsForAttempt(client, attempt.id)` returned an empty array even though `attempt_questions` had 5 rows and `question_versions` had 5 published snapshots — the JOIN simply didn't match.

**Cause:** Two distinct version columns mean different things in the data model:

1. `questions.version` — the version number the **next** save will assign. Bumped at the END of `publishPack` (after the snapshot is inserted) and at the END of `updateQuestion` (after the snapshot of the OLD content is inserted). So at any moment, `questions.version` is **one higher** than the most recent snapshot that actually exists in `question_versions`.
2. `question_versions.version` — the historical snapshot, written BEFORE `questions.version` is bumped.

Module 06's `listActiveQuestionPoolForPick` was reading `q.version` from the live questions table. The service then pinned `attempt_questions.question_version = q.version` (e.g., 2 right after publishPack). But the only snapshot that exists is `question_versions(version = 1)` — the one publishPack wrote *before* bumping. The JOIN `qv ON qv.question_id = aq.question_id AND qv.version = aq.question_version` looked for `version = 2`, found nothing, and returned an empty result set.

**Fix:** Changed `listActiveQuestionPoolForPick` (in `modules/06-attempt-engine/src/repository.ts`) to return the **latest existing snapshot version per question** via `MAX(qv.version)` with an INNER JOIN to `question_versions`:

```sql
SELECT q.id, MAX(qv.version)::int AS version
FROM questions q
JOIN question_versions qv ON qv.question_id = q.id
WHERE q.pack_id = $1 AND q.level_id = $2 AND q.status = 'active'
GROUP BY q.id
ORDER BY q.id ASC
```

Result: 18/18 tests pass. The semantic guarantee is preserved — the candidate sees the content as it was in the most recent committed snapshot. Admin edits-in-progress (which write new content to `questions.content` but do NOT yet write a snapshot for the new version — `updateQuestion` only snapshots the OLD content) remain invisible to in-flight attempts. The candidate sees the pre-edit content until the admin **re-publishes** the pack, which is the only operation that creates a snapshot of the now-current content.

**Prevention:**

1. **Pattern guard for any module that consumes `question_versions`:** never read `questions.version` and use it as a key into `question_versions`. The two columns have different semantics — `questions.version` is the *next* version to assign, while `question_versions.version` is the most recent committed historical snapshot. The two are always off by one in the steady state. Future modules (07-ai-grading needs frozen content for grading; 09-scoring needs frozen rubrics for archetype) MUST resolve via `MAX(qv.version)` or via the latest snapshot the same way module 06 now does. Add to `modules/04-question-bank/SKILL.md` § "Versioning model" when that section is next touched.
2. **Integration tests against real Postgres are the only reliable gate** — the unit-level service test would have looked correct because the test's mock pool returned whatever `q.version` was. The testcontainer suite caught this immediately with a real database where `publishPack`'s SQL bump and `question_versions`'s SQL insert actually committed. Every future module that reads `question_versions` MUST ship integration tests that exercise the full publish → resolve-snapshot path against a real container.
3. **No automatic enforcement is feasible** — the SQL pattern is too permissive to catch with a lint. The pattern guard above is manual discipline backed by integration tests. The most concrete safeguard: a comment block at the top of `repository.ts` for any module that consumes `question_versions`, calling out the off-by-one rule explicitly. Module 06's `listActiveQuestionPoolForPick` now has that block (`WHY MAX(qv.version), not q.version`).

**Cross-reference:** `modules/06-attempt-engine/src/repository.ts:listActiveQuestionPoolForPick`, `modules/04-question-bank/src/service.ts:publishPack` (version-bump trap site), `modules/06-attempt-engine/src/__tests__/attempt-engine.test.ts § getAttemptForCandidate "returns frozen content even after admin edits live question"` (regression guard).

## 2026-05-02 — vitest `expect(() => fn()).toSatisfy(predicate)` runs predicate against the function reference, not the thrown error

**Symptom:** During Phase 1 G1.B Session 3 verification of `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts`, three illegal-state-transition tests reported as **passing** in early iterations even though the code under test was not yet wired up correctly. When the production code was confirmed to throw the right `ValidationError`, the same three tests began failing with `expected [Function] to satisfy <predicate>`. The pattern was hiding both false negatives (tests passing without actually exercising the throw) and false positives (failing on the predicate's view of a function reference rather than the error).

**Cause:** The three tests used the shape:

```ts
expect(() => assertCanTransition('draft', 'closed')).toSatisfy(
  (e: unknown) => e instanceof ValidationError && (e as ValidationError).code === 'INVALID_STATE_TRANSITION'
);
```

`toSatisfy` from vitest's `expect` API runs the predicate against **the value passed to `expect`**, not against the result of calling that value or any error it throws. So the predicate received `() => assertCanTransition(...)` (a function reference) every time, and `(function instanceof ValidationError)` is always `false` — but vitest does not raise on a predicate returning false unless the actual throw reaches it. The interaction with `() => ...` (a thunk) plus the truthy/falsy quirks of how `toSatisfy` was being misused produced a confusing mix of passes and failures depending on whether the thunk threw.

The intended idiom for asserting *the shape of a thrown error* in vitest is either `expect(...).toThrow(matcher)` or an explicit `try/catch` with assertions on the caught value. `toSatisfy` is for asserting on a value that is already in hand, not for unwrapping thrown errors.

**Fix:** Replaced all three call-sites with explicit `try/catch`:

```ts
let caught: unknown;
try {
  assertCanTransition('draft', 'closed');
} catch (e) {
  caught = e;
}
expect(caught).toBeInstanceOf(ValidationError);
expect(caught).toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
```

Single replace pass over the three failing tests in `lifecycle.test.ts`'s state-machine `describe` block. After the fix, all 28 state-machine tests pass and the assertions actually exercise the thrown error.

**Prevention:**

1. **Pattern guard for vitest assertions on thrown errors:** Never combine `expect(() => ...).toSatisfy(predicate)` for error-shape checks. Two acceptable patterns only — (a) `expect(() => fn()).toThrow(/regex/)` or `expect(() => fn()).toThrowError(ErrorClass)` for *type-or-message* checks, (b) explicit `try/catch` + `expect(caught).toBeInstanceOf(...)` + `expect(caught).toMatchObject({ code: ... })` for *structured-error* checks (the AssessIQ `ValidationError` always carries a `code`, so this is the canonical shape). Add to module SKILL.md test-authoring sections when a new module starts shipping testcontainer integration tests.
2. **Phase 3 critique bounce condition:** Diffs that introduce `expect(() => ...).toSatisfy(...)` against thrown errors should bounce back to Sonnet with a "use try/catch + toMatchObject" instruction. The pattern is a soft-fail trap — it can produce both false-negative passes (test green, code broken) and false-positive failures (test red, code correct), so it actively hides regressions.
3. **No automatic enforcement is feasible** — vitest's `toSatisfy` is a legitimate API for non-throw assertions, so a blanket lint would over-trigger. A targeted ESLint rule like `no-toSatisfy-on-thunk` could pattern-match `toSatisfy` on an arrow function expression and warn; recorded for the future-infra backlog. Until then this is manual discipline backed by the Phase 3 bounce rule.

**Cross-reference:** `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` state-machine `describe` block; SESSION_STATE.md 2026-05-02 § "Test bugs surfaced + fixed during verification" line 88.

## 2026-05-02 — `13-notifications` email-stub `appendDevEmailLog` silently drops writes on Windows

**Symptom:** Module 05's `lifecycle.test.ts` "Dev-email log" tests failed with `ENOENT: no such file or directory, open 'C:\Users\manis\AppData\Local\Temp\aiq-test-emails-...log'` even though the test had set `process.env.ASSESSIQ_DEV_EMAILS_LOG` to a `path.join(os.tmpdir(), ...)` value (pure-backslash Windows path) and `inviteUsers` ran successfully — the dev-emails log was never written.

**Cause:** `modules/13-notifications/src/email-stub.ts:41` extracted the directory from `logPath` via `logPath.substring(0, logPath.lastIndexOf('/'))`. On Windows where the path has only `\` separators, `lastIndexOf('/')` returns `-1`, so `substring(0, -1)` returns the empty string. The subsequent `mkdir("", { recursive: true })` fails, the failure is swallowed by the surrounding `try/catch` (logged as `WARN` only), and the file is never written. The bug never surfaced before because: (a) on Linux/CI the env var is unset and the default Unix-style path uses `/`, and (b) the existing 03-users tests don't assert the log file's contents.

**Fix:** Replaced the manual `lastIndexOf('/')` with `path.dirname(logPath)` — handles both `/` and `\` separators uniformly. Single-line change at `modules/13-notifications/src/email-stub.ts:43`.

**Prevention:**

1. **Never hand-roll path splitting.** Always use `node:path` helpers (`dirname`, `basename`, `join`, `resolve`). They are OS-aware and POSIX-compatible. Hand-rolled string ops on file paths break silently on the OS the author wasn't running on.
2. **Test the dev-emails.log on Windows** at least once per release. Repeat: pick a Windows machine, set `ASSESSIQ_DEV_EMAILS_LOG=C:\path\to\log`, run a flow that calls `sendInvitationEmail`/`sendAssessmentInvitationEmail`, assert the file exists and has at least one record.
3. **Don't silently swallow errors in dev-only paths.** The `WARN` log was the only signal that the write failed — a developer running tests by hand would never see it. A future refactor should escalate dev-stub IO failures to `error` and propagate when running under `NODE_ENV=test`.

## 2026-05-02 — Question status workflow gap: assessments require `status='active'` but `04-question-bank.createQuestion` defaults to `status='draft'` and `publishPack` does NOT auto-flip

**Symptom:** Module 05's `publishAssessment` pool-size pre-flight rejected with `ValidationError("Question pool too small: 0 < 5")` even after the test created 5 questions, called `createQuestion` for each, and called `publishPack`. 15 of 69 lifecycle tests failed with the same error pattern.

**Cause:** Two-step mismatch in the question/assessment lifecycle:

1. `04-question-bank.createQuestion` inserts with `status='draft'` (DB default per `modules/04-question-bank/migrations/0012_questions.sql:34`).
2. `04-question-bank.publishPack` flips the *pack* status to `published` and snapshots all questions into `question_versions` — but does NOT flip individual question statuses. Each question stays `draft` until an admin explicitly PATCHes it via `updateQuestion(..., { status: 'active' })`.
3. `05-assessment-lifecycle.publishAssessment`'s pool-size pre-flight queries `questions WHERE pack_id=? AND level_id=? AND status='active'` per `docs/02-data-model.md:362` — finds zero rows when no admin has activated any question yet.

The schema docblock at `modules/04-question-bank/migrations/0012_questions.sql:5` ("The assessment-lifecycle module pulls questions where status = 'active'") makes the contract explicit; the gap is that module 04's tooling doesn't help admins reach that state.

**Fix (test-only):** `lifecycle.test.ts`'s `buildPublishedPack` helper now runs `UPDATE questions SET status='active' WHERE pack_id=$1` via the testcontainer superuser client after `publishPack`, simulating the admin's "activate all" workflow. Production code is unchanged — the SKILL.md "What's deferred" section flags the workflow gap.

**Prevention:**

1. **~~Phase 1.5 should ship one of two fixes~~ — landed 2026-05-02 via option (b).** `modules/04-question-bank.activateAllQuestionsForPack(tenantId, packId)` ships as the explicit admin "activate all" affordance, surfaced as `POST /api/admin/packs/:id/activate-questions`. Picked (b) over (a) because: (i) pre-activation surprises admins who want to curate which questions go live; (ii) "draft" is a real workflow state — admins author, review, then promote a curated subset. Idempotency surface: re-calling on an all-active pack throws `NO_DRAFT_QUESTIONS_TO_ACTIVATE` so the admin UI can render "already done" instead of misleading 200-with-zero. Tests at `modules/04-question-bank/src/__tests__/question-bank.test.ts § activateAllQuestionsForPack` (5 cases — happy path + draft/active/archived mix + draft-pack rejection + idempotency surface + cross-tenant invisibility).
2. **Phase 1 G1.C re-validation: complete (2026-05-02).** Module 06's `startAttempt` pool query (`listActiveQuestionPoolForPick`) and module 05's `publishAssessment` pool-size pre-flight both correctly require `status='active'`. The activate-all affordance closes the gap end-to-end: createPack → addLevel → createQuestion → publishPack → activateAllQuestions → createAssessment → publishAssessment → inviteUsers → candidate.startAttempt is now a clean workflow with no surprise `POOL_TOO_SMALL` errors hiding a status mismatch.



## 2026-05-01 — `docker compose restart` does NOT reload `env_file` — empty CLIENT_ID/SECRET in container after `.env` edit

**Symptom:** After populating `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `/srv/assessiq/.env` and running `docker compose -f infra/docker-compose.yml restart assessiq-api`, `GET /api/auth/google/start` continued to return 401 `"Google SSO is not configured"`. `python3` reading `/srv/assessiq/.env` confirmed the values were written (72 + 35 chars). `docker exec assessiq-api sh -c 'echo "$GOOGLE_CLIENT_ID"'` showed both vars EMPTY in the running container — the old (empty) values from before the merge.

**Cause:** `docker compose restart <svc>` is a **process-level restart** of the existing container — it sends SIGTERM, waits, sends SIGKILL, then re-runs the entrypoint *inside the same container instance*. Container env vars are baked at **container creation time** from `env_file:` + `environment:` directives; they are NOT re-read on restart. `env_file:` changes only take effect when the container is **recreated** (via `up -d` detecting a config diff, or `up -d --force-recreate`).

**Fix:** Replaced `docker compose restart assessiq-api` with `docker compose up -d --force-recreate --no-deps assessiq-api`. After recreate, `docker exec assessiq-api sh -c 'echo -n "$GOOGLE_CLIENT_ID" | wc -c'` returned 72 (matching the merged `.env`); the SSO start endpoint flipped from 401 to **302 Found** with proper Google OAuth `Location:` and `aiq_oauth_state` + `aiq_oauth_nonce` cookies.

**Prevention:**

1. **Repo-wide rule:** any time `/srv/assessiq/.env` (or any `env_file:` reference) changes, the affected service MUST be recreated, not just restarted. Recipe:

   ```bash
   ssh assessiq-vps "cd /srv/assessiq && docker compose -f infra/docker-compose.yml up -d --force-recreate --no-deps <service>"
   ```

   Add to `docs/06-deployment.md` § Operational recipes.
2. **Sanity check post-deploy:** after any `.env`-touching deploy, run `docker exec <container> sh -c 'echo -n "$KEY" | wc -c'` against the keys that should have changed; mismatch vs the file's value means the container wasn't recreated.
3. **Cross-reference for next session:** the issue is documented here so future "I changed .env and the service didn't pick it up" debugging skips the wrong rabbit holes (was it sed? is the file readable? is the python merge wrong?). The answer is almost always: `restart` ≠ `recreate`.

## 2026-05-01 — `.env.local` key name `GOOGLE_REDIRECT_URI` does not match config schema `GOOGLE_OAUTH_REDIRECT`

**Symptom:** Local `.env.local` had `GOOGLE_REDIRECT_URI=https://assessiq.automateedge.cloud/api/auth/google/cb` set. After scp'ing into `/srv/assessiq/.env` and recreating the api, the SSO start endpoint still 401'd. Container env showed `GOOGLE_OAUTH_REDIRECT=<EMPTY>` (the canonical name) while `GOOGLE_REDIRECT_URI` was set with the value the user provided. Code at [`modules/01-auth/src/google-sso.ts:126`](../modules/01-auth/src/google-sso.ts#L126) and `:192` reads `config.GOOGLE_OAUTH_REDIRECT`, fails on missing redirect, returns 401.

**Cause:** Two different conventions for the OAuth redirect-URI env-var name. The `.env.example` template + Zod schema in [`modules/00-core/src/config.ts:68`](../modules/00-core/src/config.ts#L68) standardised on `GOOGLE_OAUTH_REDIRECT`. The user's local `.env.local` uses `GOOGLE_REDIRECT_URI` (the more common Google OAuth convention name). The merge script faithfully copied each key by exact name — `GOOGLE_REDIRECT_URI` ≠ `GOOGLE_OAUTH_REDIRECT`, so the canonical key remained empty.

**Fix:** Appended `GOOGLE_OAUTH_REDIRECT=https://assessiq.automateedge.cloud/api/auth/google/cb` to `/srv/assessiq/.env` (canonical key per schema). Recreated the api; SSO start returned 302.

**Prevention:**

1. **Local file convention:** the user's `.env.local` should rename `GOOGLE_REDIRECT_URI` → `GOOGLE_OAUTH_REDIRECT` to match the schema. Documented in the next SESSION_STATE handoff.
2. **Future merge scripts** should validate keys against the Zod schema in `modules/00-core/src/config.ts` and surface mismatches BEFORE writing. A simple "keys in .env.local that aren't in the schema" warning would have caught this.
3. **`.env.example` is the canonical key list.** Any local `.env*` file should use exactly those keys; rename-aliasing is anti-pattern.

## 2026-05-01 — `assessiq-api` container marked `(unhealthy)` despite serving 200 externally

**Symptom:** `docker ps` showed `assessiq-api ... Up 2 hours (unhealthy)` after the Phase 0 closure deploy. External requests via Caddy → `127.0.0.1:9092` returned 200 on `/api/health`. `docker inspect assessiq-api --format '{{json .State.Health.Log}}'` revealed every healthcheck attempt had failed with `wget: can't connect to remote host: Connection refused`. The unhealthy badge was blocking `assessiq-frontend.depends_on: condition: service_healthy` from satisfying when the frontend container was about to ship.

**Cause:** The compose healthcheck at [`infra/docker-compose.yml:94`](../infra/docker-compose.yml#L94) (pre-fix) used `wget -q --spider http://localhost:3000/api/health`. In `node:22-alpine` (the `assessiq-api` runtime base) the `/etc/hosts` entry for `localhost` resolves to `::1` (IPv6) first; `wget`'s default behaviour is to try the first address-family entry, fail, and surface `Connection refused` without falling back. Fastify (the API server) defaults to listening on `0.0.0.0` — IPv4 only — so the IPv6 `::1` connect attempt has nothing to connect to. External traffic worked because Docker's port mapping `9092:3000` forwards explicitly to the IPv4 listener; only the in-container loopback healthcheck saw the IPv6/IPv4 family mismatch.

**Fix:** Swap `localhost` → `127.0.0.1` in the healthcheck (commit `3ef4e25`). The IPv4 literal forces the connect to the family Fastify is actually listening on. Recreating the container picked up the new healthcheck definition; `(unhealthy)` flipped to `(healthy)` within one healthcheck interval (15 s).

**Prevention:**

1. **Repo-wide policy:** for any future Alpine-based service that performs an in-container loopback healthcheck against a Node/Fastify/Express upstream, prefer `127.0.0.1` over `localhost` in compose `healthcheck.test` lines. If IPv6 dual-stack is genuinely required, listen on `::` in the application AND verify the healthcheck. Add to `docs/06-deployment.md` § Dockerfile authoring conventions when that section grows.
2. **Avoid the symptomatic mitigation of `condition: service_started`:** that band-aid lets dependent services start without the health gate but masks real outages. Fix the healthcheck instead.
3. **Cross-reference:** the `assessiq-frontend` `depends_on` was relaxed to `service_started` in the same commit because the static SPA does not require the API up to start (Caddy splits `/api/*` to a separate host port). That decision is independent of this fix and remains correct on its own merits.

## 2026-05-01 — Postgres role membership missing: `assessiq_app` cannot SET ROLE `assessiq_system`

**Symptom:** During Phase 0 closure live drills, `GET /api/auth/google/start?tenant=wipro-soc` returned `HTTP 500 INTERNAL` instead of the expected 302 (or the deferred 401 "Google SSO is not configured" when OAuth credentials are absent). API container logs surfaced `DatabaseError: permission denied to set role "assessiq_system"` thrown from `getTenantBySlug` at [modules/02-tenancy/src/service.ts:37](../modules/02-tenancy/src/service.ts#L37) when it executed `SET LOCAL ROLE assessiq_system` inside the system-role transaction. The same pattern is also load-bearing in `apiKeys.authenticate` at [modules/01-auth/src/api-keys.ts:182](../modules/01-auth/src/api-keys.ts#L182) — meaning every API-key-authenticated request would have failed identically the moment it reached production. Drill C (alg=none) and Drill D (replay) had not yet exposed this because `verifyEmbedToken` runs inside `withTenant(...)` which uses the application role's normal RLS path, not the system-role escape.

**Cause:** [`modules/02-tenancy/migrations/0002_rls_helpers.sql`](../modules/02-tenancy/migrations/0002_rls_helpers.sql) creates the three roles (`assessiq` superuser, `assessiq_app` RLS-enforced, `assessiq_system` BYPASSRLS) and grants table privileges to the app + system roles, but does NOT grant `assessiq_system` MEMBERSHIP to `assessiq_app`. Postgres requires `GRANT assessiq_system TO assessiq_app` for `assessiq_app` to be a member of `assessiq_system` and thus permitted to `SET ROLE assessiq_system`. Without the grant, the SET ROLE inside the transaction fails with `permission denied to set role`, which propagates as an unhandled DatabaseError → 500 INTERNAL via the Fastify error handler. The library functions that depend on this pattern (`apiKeys.authenticate`, `getTenantBySlug`) had been integration-tested only against `testcontainers` setups where the role grants were configured by the test fixture, so the missing migration GRANT was masked.

**Fix:** Applied `GRANT assessiq_system TO assessiq_app` directly on the production database via `docker exec assessiq-postgres psql -U assessiq -d assessiq -c 'GRANT assessiq_system TO assessiq_app;'`. After the grant, `pg_auth_members` shows `assessiq_system → assessiq_app` and the `SET LOCAL ROLE` inside the system-role transaction succeeds. Drill B's 500 promoted to 401 `"Google SSO is not configured"` (the expected DEFERRED-CLEAN state given empty `GOOGLE_CLIENT_ID`).

**Prevention:**

1. ~~**Append the GRANT to the migration:**~~ — **landed 2026-05-01 in the same closure carry-over commit that shipped `listEmbedSecrets`.** `modules/02-tenancy/migrations/0002_rls_helpers.sql` now ends with `GRANT assessiq_system TO assessiq_app;` plus a comment block documenting the prod-hotfix history and idempotency. Fresh-VPS bootstrap will reproduce the production grant set without manual `psql -c`.
2. **Integration test:** `modules/01-auth/src/__tests__/api-keys.test.ts` should add a test that exercises `apiKeys.authenticate` against a Postgres bootstrapped *without* manually-applied role grants — i.e., from the migration alone. Same shape for a future `02-tenancy/__tests__/service.test.ts` covering `getTenantBySlug`. If either test fails, the migration is missing the GRANT.
3. **Deploy-time smoke:** the first-boot bootstrap procedure in `docs/06-deployment.md` § first-boot bootstrap should grow a verification step: after migrations apply, run `psql -c "SET ROLE assessiq_system; SELECT 1;"` as `assessiq_app` to assert membership before bringing up the API container. Catches the gap pre-traffic rather than at first auth attempt.

**Cross-reference:** the Dockerfile-pnpm-filter RCA below was the OTHER deploy-day blocker hit in the same closure session; both surfaced because Phase 0 closure was the first time the API container actually started against production state. Future "first deploys of a new module" should expect 1-2 such operational-state gaps and budget an hour for the discovery loop.

## 2026-05-01 — Dockerfile pnpm filter doesn't create per-module `node_modules` for transitive deps

**Symptom:** First Docker build of `assessiq-api` failed during the runtime stage with `failed to compute cache key: failed to calculate checksum of ref ...: "/app/modules/00-core/node_modules": not found`. Build context was sound (Dockerfile present, lockfile in tarball, deps stage completed `pnpm install` successfully); the runtime stage's enumerated COPY of each workspace member's `node_modules` failed on the first absent directory.

**Cause:** [`infra/docker/assessiq-api/Dockerfile` (initial version, commit `58eba33`)](../infra/docker/assessiq-api/Dockerfile) ran `pnpm install --frozen-lockfile --filter '@assessiq/api...'` in the deps stage, then enumerated `COPY --from=deps /app/<member>/node_modules ./<member>/node_modules` for every workspace member (00-core, 01-auth, 02-tenancy, 03-users, 13-notifications). pnpm's `--filter` flag installs the transitive closure but creates per-member `node_modules` SELECTIVELY — only when a member has its own declared deps that aren't already symlinked from a parent. For 00-core specifically, the strict-mode resolution put the deps in `/app/node_modules/.pnpm/` and symlinked them through `/app/apps/api/node_modules/`, leaving `/app/modules/00-core/node_modules/` un-created. The runtime stage tried to COPY a non-existent path → build error.

**Fix:** Replaced the enumerated per-member COPYs with a single tree copy: `COPY --from=deps /app/. ./` (commit `0789e4f`). Whatever pnpm produces under `/app/` in the deps stage gets carried verbatim into runtime; source files from the build context are layered on top. Same image size, same Docker layer caching characteristics (deps stage is one cacheable layer, source overlay is the other), simpler Dockerfile.

**Prevention:**

1. **Pattern guard for future workspace Dockerfiles:** "If you're using `pnpm install --filter X...` in a multi-stage Docker build, do NOT enumerate per-member `node_modules` COPYs in the runtime stage. Always tree-copy `/app/.` from deps." Add to `docs/06-deployment.md` § Dockerfile authoring conventions when that section grows.
2. **Local Docker build before commit:** the @assessiq/api `package.json` doesn't have a `docker:build` script, so the Dockerfile change in commit `58eba33` was unverified locally. Add `docker:build` (e.g. `docker build -f ../../infra/docker/assessiq-api/Dockerfile -t assessiq/api:dev ../..`) and a CI job that runs it on PRs touching the Dockerfile. Phase 1 follow-up.
3. **No symptomatic remediation needed at runtime** — Node module resolution from `apps/api` walks up to `/app/node_modules/.pnpm/` for transitive deps even when intermediate `node_modules` directories don't exist; the build-time COPY error was the only manifestation, and the fix is layout-only.

## 2026-05-01 — W4+W5 working-tree stall: 30+ uncommitted files across two parallel sessions

**Symptom:** A Phase 0 closure session opened on `main` and found 30+ uncommitted files (modules/01-auth/**, modules/03-users/**, apps/web/**, apps/api/**, modules/13-notifications/**, tools/migrate.ts, tenancy/test/index modifications) plus an `AGENTS.md` claude-mem context dump in the repo root. Both Window 4 (01-auth) and Window 5 (03-users) had been substantially drafted by separate Claude sessions running concurrently in the same workspace, neither had committed, and an interleaving observability session had landed `f402637` on `origin/main` between them — consuming W4's staging area along the way ([memory observation 312](claude-mem:get_observations)). Each parallel session was unable to deterministically isolate "its" changes because the working tree was now a tangle of three independent feature graphs sharing files (`pnpm-lock.yaml`, `vitest.setup.ts`, `modules/02-tenancy/src/index.ts`).

**Cause:** Multiple Claude Code sessions ran in the **same** working directory without `git worktree` isolation. The global CLAUDE.md Phase 1 rule says `isolation: "worktree"` for cross-cutting writes, but two human-driven primary sessions were opened against `e:\code\AssessIQ` directly (different VS Code windows, same git checkout), each editing module-internal files plus the shared workspace plumbing (`pnpm-lock.yaml`, `vitest.setup.ts`, monorepo root configs). The third session (observability) similarly ran in the same checkout, committed first because it finished first, and silently took `tools/migrate.ts` + the redis.ts streamLogger conversion + `vitest.setup.ts` env additions into `f402637` — leaving the W4 + W5 sessions to discover post-hoc that "their" changes had been partially committed by someone else. Compounding the tangle: neither parallel session had run a Phase 2 gate sweep before pausing, so the working tree accumulated ~6,700 lines of unstaged diff before any human realized the state was unrecoverable from inside the broken sessions.

**Fix:** A dedicated triage session (this one) untangled the tree:

1. Confirmed `1e403e0 feat(users)` (W5) had already shipped during the parallel work — Commit 2 of the original triage plan was already on main.
2. Confirmed `f402637 feat(observability)` had absorbed the spillover infrastructure files (migrate.ts, vitest.setup.ts env, redis.ts conversion).
3. Audited the staged state in [git status](git status) — found 41 files cleanly representing W4 (modules/01-auth/** + 02-tenancy additive `setPoolForTesting` re-export + 00-core/02-tenancy local `vitest.config.ts` files + Google SSO test placeholders in `vitest.setup.ts`).
4. Read every staged source file directly (Phase 5 invariant verification, Opus-direct adversarial review per user-driven `codex:rescue` takeover): confirmed HS256 whitelist + decode-header fast-reject, `keyDecoder` round-trip, SADD per-user index carry-forward at [sessions.ts:133-134](modules/01-auth/src/sessions.ts#L133-L134), CF-Connecting-IP fail-closed in production, `normalizeEmail` in Google SSO callback, RLS two-policy template on every tenant-bearing table.
5. Patched one latent foot-gun in [require-auth.ts:66-77](modules/01-auth/src/middleware/require-auth.ts#L66-L77) (API-key paths now throw on `roles`/`freshMfa` gates instead of silently passing).
6. Committed W4 as `d9cfeb4` and the 5-line mock-seam swap (03-users → real `@assessiq/auth.sessions`) as `be96623`.
7. Applied migrations 010-015 to `assessiq-postgres` via `psql -f` (consistent with W2/W5 deploy pattern; production has no `schema_migrations` bootstrap yet, and `tools/migrate.ts` carries a separate latent ordering issue documented as a Phase 1 follow-up).

**Prevention:**

1. **Process rule (manual discipline):** Cross-cutting parallel sessions on the same module-graph segment MUST run in separate `git worktree`s with their own pnpm install per the global CLAUDE.md Phase 1 isolation note. The cost of one stalled tree (lost hours of triage) is much higher than the ~15s `git worktree add` overhead. Record on the user's "before opening a second session in the same workspace, fork a worktree" rule of thumb.
2. **Process rule (Phase 2 gates before pause):** A session that pauses with uncommitted work MUST run the Phase 2 gate sweep (typecheck + tests + secrets + RLS lint + ambient-AI grep) and either commit-and-push or stash-with-explicit-name. The diagnostic surface a triage session needs is "what passed gates" — an unstashed dirty tree gives the next session no signal.
3. **Tooling backlog:** No automatic enforcement is feasible here — git itself has no concept of "session ownership" of paths, and IDE-level locks would regress on the multi-VS-Code-window workflow the user actually uses. The project-overlay CLAUDE.md `## Phase 0 — warm-start reading list` could grow a "if `git status` shows >5 unstaged files at session start, treat as triage mode" instruction; recorded here as a future soft-prompt change rather than a hook.
4. **Migration runner ordering bug surfaced during this triage:** `tools/migrate.ts` lexical sort puts `010_oauth_identities.sql` before `020_users.sql`, which would FK-fail on a fresh DB. Production avoided this by applying W2 migrations before W4/W5 migrations existed, and by using `psql -f` directly. Phase 1 should rewrite `tools/migrate.ts` to either (a) topological sort by FK references or (b) apply per-module-directory in a declared dependency order. Test suite at `modules/03-users/src/__tests__/users.test.ts:125-156` already does the latter as a workaround.

## 2026-05-01 — TOTP enrollConfirm/verify HMACed wrong bytes (lossy @otplib base32 round-trip)

**Symptom:** Every Window-4 TOTP integration test that called `totp.enrollConfirm()` with a code from `authenticator.generate(secretBase32)` failed with `ValidationError: invalid totp code`. 11 of 14 testcontainer-backed TOTP tests red. **Would have caused 100% TOTP-enrollment failure in production** — any admin completing first-login MFA enrollment via Google Authenticator / Authy / 1Password / Microsoft Authenticator would be permanently rejected, blocking the entire admin-login flow tenant-wide.

**Cause:** [`modules/01-auth/src/totp.ts:194-209`](../modules/01-auth/src/totp.ts#L194) (enrollConfirm) and [`:282-296`](../modules/01-auth/src/totp.ts#L282) (verify) called `totpToken(secretBase32, opts)` directly. `@otplib/core`'s `totpToken` does NOT apply the keyDecoder — it expects the secret already in `opts.encoding` (LATIN1 here = raw bytes as a latin1 string). The base32 string was being HMACed as if it were raw bytes. Meanwhile the user's authenticator app generates codes against the **post-keyDecoder** bytes (base32 → bytes via the `thirty-two` plugin). Worse, the round-trip `authenticator.encode(latin1) → keyDecoder(b32, latin1)` is **lossy** for any byte with the high bit set: every `0x80-0xFF` byte gets cleared to `0x00-0x7F` (the encoder treats the latin1 input as 7-bit ASCII somewhere in the chain). With 20 random bytes (~50% high-bit), prod and the app HMAC entirely different byte sequences. Confirmed empirically with a standalone repro: same secret, same epoch, same opts — `auth.generate(b32)` → `718816`, `totpToken(latin1, opts)` → `228061`. Decoding via `opts.keyDecoder(b32, opts.encoding)` first → `718816` ✓.

**Fix:** Route the secret through `opts.keyDecoder(secretBase32, opts.encoding)` before passing to `totpToken` in both [`enrollConfirm`](../modules/01-auth/src/totp.ts#L194) and [`verify`](../modules/01-auth/src/totp.ts#L283). This matches what `authenticator.generate(b32)` does internally. Also fixed the same buggy pattern in [`modules/01-auth/src/__tests__/totp.test.ts:339-369`](../modules/01-auth/src/__tests__/totp.test.ts#L339) (drift tests called `totpToken(secret, opts)` with `secret` being base32) — replaced with `authenticator.clone({ epoch }).generate(b32)` for the canonical path. Also relaxed the constant-time test threshold from 1ms to 5ms with a clarifying comment: the test measures whole-call `verify()` time which includes Redis cleanup that's structurally asymmetric (success: 1 DEL + 1 fire-and-forget UPDATE; failure: 1 INCR + EXPIRE NX + sometimes SET locked) — that's ~1 extra Redis round-trip on the failure path, sub-ms on a quiet local but >1ms in noisier environments. The actual constant-time invariant we care about (no early-exit on partial digit match) lives in `crypto.timingSafeEqual` in the comparison loop and is unaffected.

**Prevention:** Manual discipline backed by 14 integration tests covering enrollment + verify-current + verify-±1-drift + verify-out-of-window + lockout + recovery. Lint can't easily catch this — it's a semantic mismatch between what encoding `totpToken` expects and what the value actually carries; the `KeyEncodings.LATIN1` declaration is structurally correct but the value wasn't pre-decoded. The `keyDecoder` step in totp.ts is now annotated with a comment explaining the lossy-encode pitfall so future readers don't "simplify" it back to raw `secretBase32`. Future regression would re-fail the 11 testcontainer cases immediately.

## 2026-05-01 — W4 test path arithmetic mis-resolved 02-tenancy migrations (3 of 6 suites failed to load)

**Symptom:** `pnpm --filter @assessiq/auth test` reported 3 of 6 suites with every test marked `skipped`: `api-keys.test.ts` (11 skipped), `sessions.test.ts` (16), `totp.test.ts` (14). Vitest log buried at the top: `Error: ENOENT: no such file or directory, scandir 'E:\code\AssessIQ\02-tenancy\migrations'` — note the missing `modules/` prefix. The all-skipped result is also misleading: vitest reports failed-to-load suites with their tests counted as "skipped" rather than "failed", making the failure mode easy to miss in summary lines.

**Cause:** [`modules/01-auth/src/__tests__/api-keys.test.ts:45`](../modules/01-auth/src/__tests__/api-keys.test.ts#L45), [`sessions.test.ts:37`](../modules/01-auth/src/__tests__/sessions.test.ts#L37), [`totp.test.ts:56`](../modules/01-auth/src/__tests__/totp.test.ts#L56) all defined `AUTH_MODULE_ROOT = join(THIS_DIR, "..", "..", "..")` — three `..` from `modules/01-auth/src/__tests__/` lands at `modules/`, not `modules/01-auth/`. Then `MODULES_ROOT = join(AUTH_MODULE_ROOT, "..")` resolved to repo root, and `join(MODULES_ROOT, "02-tenancy", "migrations")` looked at `<repo-root>/02-tenancy/migrations` — non-existent. The companion `google-sso.test.ts` had been corrected to two `..` in an earlier W4 fix-pass (per memory observation 231) but the fix never propagated to the other three suites in the same module. The misleading `// modules/01-auth/` comment next to the broken line stayed in place across all three files, hiding the off-by-one.

**Fix:** All three files now use `join(THIS_DIR, "..", "..")` matching `google-sso.test.ts`. Comment block in `api-keys.test.ts` corrected from `From there: ../../../ = modules/01-auth/` (false) to a step-by-step `1 ..  →  modules/01-auth/src/  /  2 ..  →  modules/01-auth/  /  3 ..  →  modules/`.

**Prevention:** Manual discipline. A future safeguard worth considering: a small assert at module top — `if (!existsSync(TENANCY_MIGRATIONS)) throw new Error(...)` — would surface path drift at module-load time rather than as an opaque ENOENT during fixture scan that vitest then converts to "all skipped." Not added in this commit; recorded here for the future-infra backlog. A second guardrail: when adding new test suites under an existing module, copy the `THIS_DIR / AUTH_MODULE_ROOT / MODULES_ROOT` block from a known-working sibling rather than authoring from scratch.

## 2026-05-01 — modules/00-core and modules/02-tenancy tests silently skipped since their bootstrap commits

**Symptom:** `pnpm --filter @assessiq/core test` and `pnpm --filter @assessiq/tenancy test` returned `No test files found, exiting with code 1` despite each module having on-disk test files (5 files / 93 cases in 00-core; 1 file / 11 cases in 02-tenancy). Worse, `pnpm -r test` was bailing at the 00-core failure and never reaching 01-auth/03-users — masking other test failures upstream. The W5 SESSION_STATE's reported "32 pass / 0 fail / 8 todo" silently elided the 104 cases that never ran. Discovered during W4 triage when re-running the workspace test suite.

**Cause:** Neither module shipped a local `vitest.config.ts`. When `vitest run` is invoked from the module's cwd (via `pnpm --filter <pkg> test`), vitest walks up to find the root [vitest.config.ts](../vitest.config.ts) whose `include: ["modules/**/__tests__/**/*.test.ts", "packages/**/__tests__/**/*.test.ts"]` is interpreted **relative to vitest's cwd** (= the module directory). Lookup becomes `modules/00-core/modules/**/__tests__/...` → no matches → vitest exits 1. The 01-auth and 03-users packages had each shipped local `vitest.config.ts` files (added when those modules first introduced testcontainer-backed integration tests with longer timeouts), so their per-module `vitest run` invocations picked up the local config and avoided the cwd-resolution issue. The breakage went unnoticed because every recent session ran tests via `pnpm --filter @assessiq/<other-module> test`, never per-package on the silent ones.

**Fix:** Added [`modules/00-core/vitest.config.ts`](../modules/00-core/vitest.config.ts) and [`modules/02-tenancy/vitest.config.ts`](../modules/02-tenancy/vitest.config.ts), both minimal `defineConfig({ test: { setupFiles: ["../../vitest.setup.ts"] } })` (02-tenancy adds 90s testcontainer timeouts), matching the 01-auth pattern. Per-module `pnpm --filter … test` now picks up the local config and skips the cwd-resolution trap. After the fix: 00-core 93/93 pass; 02-tenancy 10/11 pass + 1 todo (W4's `setPoolForTesting` re-export and import-split modifications confirmed not regressing 02-tenancy's integration tests — the load-bearing modification is safe).

**Prevention:** The root-config include pattern is the underlying flakiness. Two non-bandage paths forward, both deferred: (a) move `include` into per-module configs only and treat the root config as a defaults-fallthrough; (b) leave the root pattern in place but add a `tools/lint-vitest-configs.ts` CI script that enumerates `modules/*/package.json` packages with a `test` script and asserts a sibling `vitest.config.ts` exists. For now: convention is "every module with tests ships its own vitest.config.ts." Recorded here so a future infra cleanup picks up the lint-script idea.

## 2026-05-01 — assessiq.automateedge.cloud returning 502 (Phase 0 premature DNS+Caddy wiring)

**Symptom:** Cloudflare error page on `https://assessiq.automateedge.cloud/` — "Bad gateway, Error code 502". Browser → Cloudflare path healthy, origin host marked "Error". Other apps on the shared VPS (`accessbridge`, `roadmap`, `ti-platform`, `intelwatch.in`) unaffected.

**Cause:** Caddy block in `/opt/ti-platform/caddy/Caddyfile` (lines 65–73 pre-fix) reverse-proxied `assessiq.automateedge.cloud` to `172.17.0.1:9091`, but no container was bound to host port 9091. `assessiq-frontend` was never built (no `assessiq/*` Docker images on box) and never started; only `assessiq-postgres` was running (provisioned earlier today for `02-tenancy` migration work). DNS A record (proxied) and Caddy block were both provisioned during early Phase 0 deploy plumbing, ahead of the actual `assessiq-frontend` deploy. Cloudflare reached origin Caddy successfully; Caddy got connection-refused from the missing upstream and returned 502.

**Fix:** Replaced the `reverse_proxy 172.17.0.1:9091 { ... }` directive in the AssessIQ Caddy block with a `respond 200` placeholder that serves a minimal HTML "We are building" page directly from Caddy. No new container, no new image, no new resource consumption. Block now: `header Content-Type "text/html; charset=utf-8"; header Cache-Control "no-store"; respond 200 { body "<HTML>"; close }`. Edit applied via in-place truncate-write to preserve the bind-mount inode (single-file mount `/opt/ti-platform/caddy/Caddyfile -> /etc/caddy/Caddyfile`), validated with `caddy validate`, then graceful `caddy reload`. External smoke through Cloudflare returns 200 with expected body and security headers; `cf-cache-status: DYNAMIC` confirms `no-store` honored. Caddyfile pre-edit backup at `/opt/ti-platform/caddy/Caddyfile.bak.20260430-205811` on the VPS.

**Prevention:**

1. Documentation: `docs/06-deployment.md` § "Current live state — Phase 0 placeholder" now records that the target reverse-proxy block is **aspirational** until `assessiq-frontend` ships, and pins the swap-back procedure (with the inode-preservation rule). Future sessions reading the deployment doc see the divergence between target and live state explicitly.
2. Process rule: do **not** wire DNS + Caddy for an AssessIQ subdomain ahead of the corresponding container deploy. If the public domain has to exist (e.g. for stakeholder previews), the Caddy block must use `respond` (or a static `file_server` with a placeholder) until the upstream is verified live with `curl 172.17.0.1:<port>` from the VPS. Treat "Caddy block points to unbound host port" as a Phase 3 bounce condition for any deploy diff.
3. Bind-mount inode trap: this is the second incidence of the inode-preservation gotcha on this VPS (the `CLAUDE.md` "Caddy bind-mount inode" note already flagged it). The swap-back procedure in `06-deployment.md` now spells out `cat new > Caddyfile` (truncate-write) and the `never mv` rule explicitly.

**Order-of-operations note:** the Definition-of-Done order (commit → deploy → document → handoff) was inverted for this incident — production was returning 502, so the Caddyfile fix was deployed before the documenting commit. The deploy is captured in this RCA + the deployment doc + the SESSION_STATE handoff in the same commit, so the live state is reproducible from this SHA. For non-incident work the standard order applies.

## 2026-04-30 — CF Origin Cert paste artifact silently failed `openssl x509` parse

**Symptom:** During first-time TLS bootstrap on the VPS, `openssl x509 -noout -subject -in /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem` exited with `Could not read certificate from <path>` and a non-zero status. The cert file was non-empty, the BEGIN/END markers were present, and the file appeared visually correct in `cat`. No error from `scp`, no error from `chmod`. The same artifact would have caused `openssl rsa -modulus -noout` on the key to fail identically; modulus-MD5 cert↔key matching could not even be attempted until the parse succeeded.

**Cause:** The Cloudflare dashboard renders the cert and key inside a copy-able `<textarea>` whose contents include a leading horizontal-tab character on every line plus CRLF (`\r\n`) line endings. Browser copy-then-paste preserves both. PEM is whitespace-strict at the line boundary — leading whitespace inside a cert block invalidates the base64 decode, and CRLF is not consistently tolerated by OpenSSL's PEM reader (the failure mode is a silent "Could not read certificate" rather than a precise parser diagnostic). Origin file: cert + key as pasted into `/opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.{pem,key}` from the CF Zero Trust → Origin Server → Create Certificate dialog on 2026-04-30.

**Fix:** Strip both artifacts in place before any verify step:

```bash
sed -i 's/\r$//; s/^[[:space:]]*//' \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.pem \
  /opt/ti-platform/caddy/ssl/assessiq.automateedge.cloud.key
```

Then re-verify:

```bash
openssl x509 -noout -subject -in <pem>                         # expect: subject=CN=*.automateedge.cloud
openssl rsa  -noout -modulus -in <key> | openssl md5           # cert/key modulus-MD5 must match
openssl x509 -noout -modulus -in <pem> | openssl md5           # ↑ confirms pair
```

Caddy itself was tolerant of the leading whitespace in this case — `caddy validate` returned `Valid configuration` and `caddy reload` was clean — so the gotcha was caught only because the deploy procedure runs `openssl` verification BEFORE the Caddy reload. If the verify step had been skipped, Caddy would have served the file but a future cert-rotation step (or any tool that re-parses the PEM with stricter parsers — `step certificate inspect`, OpenSSL ≥ 3.x in some configs, certain monitoring exporters) could have failed unpredictably. The recorded session also cleaned the local desktop copies, since they would have re-introduced the artifact on any future re-paste. Captured in `docs/SESSION_STATE.md @ 5f5aa99` § "Sharp edges" and the deploy infrastructure table.

**Prevention:**

1. Documentation: `docs/06-deployment.md` § "Apply procedure (Phase 0 G0.A deploy step)" cert procurement step gets a one-line note inserted between steps 2 and 3 — "After `scp`, immediately run `sed -i 's/\\r$//; s/^[[:space:]]*//' <pem> <key>` to strip CF dashboard paste artifacts, then verify with `openssl x509 -noout -subject` before Caddy reload." The same note covers any future cert rotation. This is the highest-leverage prevention because the gotcha re-arises on every CF dashboard paste, not just first-time bootstrap.
2. Process rule: **`openssl x509 -noout -subject` + cert/key modulus-MD5 match must succeed BEFORE any `caddy validate` or `caddy reload`.** Caddy's PEM reader is more forgiving than OpenSSL's, and a Caddy-only validation can mask a cert that other tooling can't parse. Treat "cert installed but openssl verify not run" as a Phase 3 bounce condition for any deploy diff that touches `/opt/ti-platform/caddy/ssl/`.
3. Manual discipline (no lint/hook): there is no good way to enforce this from inside the repo because the cert is pasted on the VPS, not committed. The deploy doc note + the Phase 3 bounce rule are the available levers. A possible future hook is a VPS-side `pre-reload` wrapper around `caddy reload` that runs the openssl checks against any `*.pem` newer than the last reload; out of scope for this entry.

**Cross-reference:** `docs/06-deployment.md` § Disaster recovery → § Failure modes & runbooks "VPS dead" branch references this RCA, since rebuilding from a fresh CF Origin Cert paste re-exposes the same artifact.

## 2026-05-02 — help_content RLS: three integration-only bugs caught by testcontainers

**Symptom:** During Phase 1 G1.A Session 2 integration test authoring, three RLS-shaped bugs surfaced — all silent failures with no SQL error in the developer's terminal:

1. **Empty-string GUC cast.** `getHelpKey(null, 'candidate.attempt.flag', 'en')` from a globals-only path would intermittently fail with `invalid input syntax for type uuid: """` after a prior `withTenant` call had populated `app.current_tenant` on the same pooled connection. The error surfaced as a 500 on what should be the cheapest, safest read in the system.
2. **FOR ALL policy's implicit WITH CHECK for INSERT.** A test asserted `app role cannot insert tenant_id IS NULL row` and **passed** — meaning the app role could silently insert global help rows, defeating the defense-in-depth design. Globally-readable content overrides could have been planted by a fully-compromised tenant session.
3. **WITH CHECK NULL vs FALSE semantics.** Even with the FOR INSERT policy split out, `WITH CHECK (tenant_id = current_setting(...)::uuid)` allowed `tenant_id = NULL` because `NULL = <expr>` evaluates to NULL, and `WITH CHECK` only blocks on FALSE.

**Cause:**

1. **Empty-string GUC.** `current_setting('app.current_tenant', true)` returns `""` (not NULL) on a pooled connection where a prior `withTenant` transaction set the GUC to a real uuid. After that transaction commits, the session-level value can persist as the empty string `""` in some pg-pool lifecycle paths. The RLS USING clause's `...::uuid` cast then throws on the empty string instead of returning NULL.
2. **FOR ALL footgun.** The original migration declared a single `CREATE POLICY tenant_isolation ON help_content USING (tenant_id IS NULL OR tenant_id = ...)`. A bare `CREATE POLICY` defaults to `FOR ALL` and, per Postgres docs, "if no WITH CHECK clause is given, then the same expression is used for both the USING clause and the WITH CHECK clause". The USING included `tenant_id IS NULL` so global reads worked — and the same clause as `WITH CHECK` made INSERT of NULL `tenant_id` pass (`NULL IS NULL` = TRUE).
3. **NULL vs FALSE.** WITH CHECK only blocks the row when the expression evaluates to FALSE. `NULL = <anything>` is NULL, not FALSE, so an INSERT with `tenant_id = NULL` passed the WITH CHECK even after the policy was split.

**Fix:** Split into four scoped policies — `FOR SELECT` reads globals + tenant overrides; `FOR UPDATE` and `FOR DELETE` only the tenant's own rows; `FOR INSERT` only the tenant's own bucket with explicit `tenant_id IS NOT NULL AND tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid`. `NULLIF(..., '')` converts the pg-pool empty-string back to NULL before the `::uuid` cast. `IS NOT NULL` makes `tenant_id = NULL` definitively FALSE so WITH CHECK blocks it. Migration `0010_help_content.sql` was rewritten in-place pre-deploy; `0012_fix_rls_empty_string.sql` carries the same fix as an idempotent hot-patch for any database deployed before the rewrite. `withGlobalsOnly` belt-and-suspenders adds `SET LOCAL app.current_tenant TO DEFAULT` so the GUC is reset inside the transaction even if the connection arrived with stale session state.

**Prevention:**

1. **Integration tests against real Postgres are the only reliable RLS gate.** The original 0010 migration was reviewed by Opus diff critique and lint-rls-policies.ts, which check for policy *names* not policy *behavior*. Both passed it. Only running the assertions `app role cannot insert tenant_id IS NULL` and `getHelpKey(null, ...) returns globals only` against real Postgres surfaced the bugs. Every future module with RLS must ship integration tests that exercise the *INSERT denial* path explicitly, not just the SELECT path.
2. **Pattern guard for future RLS migrations:** "Every `CREATE POLICY` against a nullable-tenant table must declare a `FOR <action>` clause explicitly. Bare `CREATE POLICY` (defaults to `FOR ALL`) on tables where USING includes `tenant_id IS NULL` is a Phase 3 bounce condition." Add to `modules/02-tenancy/SKILL.md` § Anti-patterns refused.
3. **NULLIF wrapping for nullable GUCs.** Future RLS policies that read `current_setting('app.<custom>', true)::uuid` MUST wrap with `NULLIF(..., '')` or pre-reset the GUC inside the transaction. Pooled connections leak GUC state across transactions in ways the postgres docs do not advertise.
4. **UNIQUE NULLS NOT DISTINCT for nullable composite keys.** Postgres default treats `NULL` as distinct from itself in UNIQUE constraints, so `UNIQUE (tenant_id, key, locale, version)` would let the seed migration insert duplicate global rows on every re-run. Phase 1 G1.A Session 2 caught this in Opus diff review before any deploy. Pattern: any UNIQUE on a nullable column needs `NULLS NOT DISTINCT` (Postgres 15+) or a separate partial unique index `WHERE col IS NULL`.

**Cross-reference:** `modules/16-help-system/migrations/0010_help_content.sql` (rewritten), `0012_fix_rls_empty_string.sql` (hot-patch), `modules/16-help-system/src/service.ts` (`withGlobalsOnly`), `modules/16-help-system/src/__tests__/help-system.test.ts` (Block 1 + Block 3 are the regression guards).

## 2026-05-02 — Caddy `/help/*` not forwarded — anonymous embed help endpoint fell through to SPA

**Symptom:** Phase 5 deploy smoke against the freshly-shipped `@assessiq/help-system` returned the SPA `index.html` (HTTP 200, `<!DOCTYPE html>... <title>AssessIQ</title>`) instead of the help JSON envelope when hitting `https://assessiq.automateedge.cloud/help/admin.assessments.close.early?locale=en`. The `assessiq-api` container was healthy, the route `app.get("/help/:key", ...)` was wired in `modules/16-help-system/src/routes-public.ts`, and the migrations had seeded 25 globals into `help_content`. Inside the container the route would have responded; from outside it was unreachable. The other 4 help endpoints (`/api/help`, `/api/help/:key`, `/api/help/track`, `/api/admin/help/export`) all responded correctly with the expected status codes (401 / 401 / 204 / 401), so the issue was clearly path-routing, not the help-system code.

**Cause:** The Caddy `@api` matcher in the AssessIQ block at [`/opt/ti-platform/caddy/Caddyfile`](../infra/caddy/Caddyfile) (the live one on the VPS, not in-repo) was `@api path /api/* /embed*` — only `/api/*` and `/embed*` reach `assessiq-api` on host port 9092. The bare-root `/help/*` path that `registerHelpPublicRoutes` mounts (intentionally without an `/api` prefix, mirroring the `/embed*` pattern so embed/iframe contexts have a short public URL) was never added to the matcher. Without it, Caddy's default `handle { reverse_proxy ... 9091 }` block routed the request to `assessiq-frontend`, where the SPA's catch-all returned `index.html`. The help-system's route registration was correct *by design* (memory observation 648 confirms `/help/:key` is the intended anonymous-embed surface, separate from `/api/help/:key`); the gap was purely deployment infrastructure — a one-line addition to the Caddy matcher that nobody had remembered to make when the help-system was scoped.

**Fix:** Edit the `@api` matcher to include `/help/*`:

```caddy
@api path /api/* /embed* /help/*
```

Applied via the truncate-write procedure (preserve bind-mount inode per RCA `2026-04-30`): backup with timestamped `.bak.<UTC-ts>`, scp the new file to `/tmp/Caddyfile.new`, `cat /tmp/Caddyfile.new > /opt/ti-platform/caddy/Caddyfile`, verify inode unchanged via `stat -c %i`, `docker exec ti-platform-caddy-1 caddy validate`, `docker exec ti-platform-caddy-1 caddy reload`. After reload: `/help/admin.assessments.close.early?locale=en` returns the JSON envelope; `/help/nonexistent.key` returns the API's `NOT_FOUND` error envelope (not the SPA fallback); regression check on `/`, `/admin/login`, `/api/health` all unchanged. Live block + verification recorded in `docs/06-deployment.md` § "Current live state — Phase 1 G1.A Session 2 split-route + frontend (2026-05-02)".

**Prevention:**

1. **Phase 5 smoke must include every public bare-root path the new module mounts.** It is not enough to verify the API returns 200 inside the container; the Caddy matcher must be exercised from outside the VPS. Standard recipe for any new module that mounts routes outside the `/api/*` namespace: list every `app.get("/<x>"...)` and `app.post("/<x>"...)` whose path does NOT start with `/api/`, then `curl https://<host>/<x>` for each before declaring deploy done.
2. **Module SKILL.md must declare its non-`/api/*` routes explicitly.** `modules/16-help-system/SKILL.md` lists `/help/:key?locale=` in its API surface, but the deployment doc didn't cross-reference that surface against the live Caddy matcher. Future SKILL.md files: add a `## Edge routing` section (or a 1-line note in the API block) listing every bare-root path so the Caddy block can be diffed against it during deploy review.
3. **No automatic enforcement is feasible** — `lint-rls-policies.ts` checks SQL policies against migrations, but there is no equivalent linter that knows the live Caddy matcher (which is on the VPS, not in-repo). A future `tools/lint-edge-routing.ts` could parse `apps/api/src/server.ts` for non-`/api/*` route mounts, parse the canonical Caddyfile snippet from `docs/06-deployment.md`, and assert every mounted bare-root path is in the matcher. Recorded as a Phase-2 infra-backlog item.

**Cross-reference:** `docs/06-deployment.md` (Caddy block + smoke), `modules/16-help-system/src/routes-public.ts` (the registration), memory observation `648 — Help-system route architecture confirmed`. The fix touched shared infra (the ti-platform Caddyfile) — applied as an additive matcher extension only, with backup, inode preservation, and other-domain regression checks per CLAUDE.md rule #8.

## 2026-05-03 — Phase 1 closure audit: three findings (PARTIAL result)

**Symptom:** Phase 1 closure verification (5-drill audit) run on 2026-05-03. Three bugs discovered:

**Finding A — `POST /admin/packs` with missing `slug` returns 500 (should be 400)**
`createPack` in `modules/04-question-bank/src/service.ts` calls `assertValidSlug(input.slug)` before the DB insert, but `assertValidSlug(undefined)` does not throw — the undefined propagates to `repo.insertPack` where Postgres raises `null value in column "slug" violates not-null constraint` (error code `23502`). The route layer (`routes.ts:134`) casts `req.body as CreatePackInput` without any Fastify body schema, so Fastify's schema-validation layer never fires. Same pattern exists for `topic` and `points` in `POST /admin/questions`. HTTP 500 returned instead of 400 `VALIDATION_FAILED`.

**Finding B — `POST /admin/questions` with missing `topic`/`points` returns 500 (should be 400)**
Same root cause as Finding A. `createQuestion` service does not guard against undefined `topic` or `points` before the `insertQuestion` Postgres call. HTTP 500 returned.

**Finding C (GATE FAILURE — Drill 1 blocked) — `POST /admin/assessments/:id/invite` returns 500 due to cross-phase regression in email template**
`inviteUsers` in `modules/05-assessment-lifecycle/src/service.ts:749` passes `tenantName: ""` (empty string, Phase 1 placeholder per comment at lines 28-29) to `sendInvitationEmail`. Phase 3 G3.B `modules/13-notifications/src/email/render.ts:108` added a Zod schema that validates `tenantName: z.string().min(1)` — rejecting the empty placeholder. The Zod throw propagates inside the `withTenant` transaction, rolling back the `assessment_invitations` INSERT, so the invitation row is never created. HTTP 500 returned; `assessment_invitations` table remains empty. This was a cross-phase regression: Phase 1 code used an intentional placeholder (`""`) that Phase 3 G3.B's strict Zod validation broke.

**Stack trace (Finding C):**
```
ZodError: [{"code":"too_small","path":["tenantName"],"message":"String must contain at least 1 character(s)"}]
    at renderTemplate (modules/13-notifications/src/email/render.ts:108)
    at sendEmail (modules/13-notifications/src/email/index.ts:94)
    at sendAssessmentInvitationEmail (modules/13-notifications/src/email/legacy-shims.ts:47)
    at sendInvitationEmail (modules/05-assessment-lifecycle/src/email.ts:42)
    at service.ts:743 inside withTenant → transaction rollback
```

**Cause:** Finding A/B: route layer lacks Fastify body schema for question-bank POST endpoints; `assertValidSlug` / `assertNonEmpty` guards pass on `undefined`. Finding C: Phase 1 `service.ts:749` had `tenantName: ""` as a known placeholder; Phase 3 G3.B notifications module introduced strict Zod validation incompatible with that placeholder.

**Fix:** TBD (per gate failure protocol — fixes deferred to dedicated follow-up sessions):
- A/B: Add Fastify body schema to `POST /admin/packs` and `POST /admin/questions` route handlers, OR harden `assertValidSlug` / `assertNonEmpty` to throw on `undefined`/`null` inputs, returning 400 instead of propagating to DB.
- C: Fix `modules/05-assessment-lifecycle/src/service.ts:749` — fetch the tenant name from the tenant row (already in scope via `withTenant`) instead of using a placeholder. The tenant name is available from the DB: `SELECT name FROM tenants WHERE id = $1`.

**Prevention:**
1. **Route-level schema validation is mandatory for all POST/PATCH endpoints.** The pattern `req.body as TypeX` without a Fastify JSON schema is a latent 500-for-bad-input trap. Add to CLAUDE.md Phase 3 critique: "Any POST/PATCH handler using `req.body as T` without `schema: { body: ... }` is a bounce condition."
2. **Cross-phase placeholder strings must be flagged at compilation time or tested.** An empty `tenantName: ""` passed to a rendering function that requires non-empty is a contract violation. Add an integration test for `inviteUsers` that exercises the email path even in dev-email fallback mode.
3. **Phase N regressions on Phase N-1 code paths.** When Phase 3 G3.B shipped notifications with stricter Zod validation, existing callers (`05-assessment-lifecycle`) were not audited for placeholder-value compatibility. Future module SKILL.md files should list their contract requirements on data from callers (e.g., "tenantName: non-empty string required").

**Downstream impact:** Drill 1 (candidate full-stack happy path) blocked at Step 9. Drills 3 Step 5 (token reuse) and Drill 4 (autosave + timer) also blocked (require a valid invitation token). Phase 1 closure = PARTIAL.

## 2026-05-03 — Phase 1 closure audit ran PARTIAL (3 drills pass, 1 drill partial, 1 blocked)

**Symptom:** This is the positive audit summary entry per CLAUDE.md project overlay § "If ALL 5 drills pass" (which says to append a note even for clean audits; recorded here as PARTIAL per gate failure protocol).

**Drills run on 2026-05-03:**
- **Drill 1** — PARTIAL: Steps 1-8 PASS (pack/level/question creation, pack publish, question activation, assessment creation + publish). Step 9 (invite candidate) BLOCKED by Finding C above. Steps 10-14 BLOCKED (downstream).
- **Drill 2** — PASS: RLS isolation confirmed via API + direct SQL. `closure-test@example.com` under `closure-test-tenant` not visible under wipro-soc session (API 200 without leak) or SQL `SET ROLE assessiq_app; SET app.current_tenant = '<wipro-soc-uuid>'`. Cleanup successful.
- **Drill 3** — PASS (step 5 skipped): Fake token (valid length) → `404 INVITATION_NOT_FOUND`. Empty body `{}` → `404 INVITATION_NOT_FOUND`. Too-short token → `404 INVITATION_NOT_FOUND`. No enumeration oracle — identical error code/message across all three variants. Step 5 (single-use enforcement) skipped: no real token available due to Drill 1 failure.
- **Drill 4** — BLOCKED: Requires valid invitation token to start an attempt. Blocked by Drill 1 Finding C.
- **Drill 5** — PASS: All 5 assessiq containers healthy (`api Up 27min healthy`, `worker Up 4h`, `frontend Up 7h healthy`, `redis Up 2d healthy`, `postgres Up 2d healthy`). No new systemd units. Caddyfile `@api path /api/* /embed* /help/* /take/start` correct. No non-assessiq Caddy blocks modified. All logs present and populating. `logrotate.timer` active. No new AssessIQ crontab entries. Sibling apps (`intelwatch.in 307`, `ti.intelwatch.in 200`, `accessbridge.space 200`, `automateedge.cloud 200`) all healthy.

**Phase 1 closure status: PARTIAL.** Follow-up session required to fix Finding C (invite 500) before re-running Drills 1/3/4.

## 2026-05-03 — `inviteUsers` passed `tenantName:""` to 13-notifications Zod `.min(1)` — 500 on every invite + DB rollback

**Symptom:** `POST /api/admin/assessments/:id/invite` returned HTTP 500 on every call. `assessment_invitations` table had 0 rows inserted despite the payload being valid. Phase 1 closure Drill 1 Step 9 blocked; Drills 3 Step 5 and Drill 4 also blocked downstream. Stack trace (captured in Phase 1 closure audit d5113dc):

```
ZodError: [{"code":"too_small","path":["tenantName"],"message":"String must contain at least 1 character(s)"}]
    at renderTemplate (modules/13-notifications/src/email/render.ts:108)
    at sendEmail (modules/13-notifications/src/email/index.ts:94)
    at sendAssessmentInvitationEmail (modules/13-notifications/src/email/legacy-shims.ts:47)
    at sendInvitationEmail (modules/05-assessment-lifecycle/src/email.ts:42)
    at service.ts:743 inside withTenant → transaction rollback
```

**Cause:** `inviteUsers` in `modules/05-assessment-lifecycle/src/service.ts:749` passed `tenantName: ""` — a Phase 1 placeholder that was left in when the module shipped. When Phase 3 G3.B (`13-notifications`) shipped, `InvitationCandidateVarsSchema` added `tenantName: z.string().min(1)`, which correctly rejected the empty placeholder. The ZodError propagated inside the `withTenant` transaction, causing a ROLLBACK. The placeholder comment at lines 28-31 and the TODO comment at line 742 both documented the intent to fix this in a follow-up; the follow-up was deferred until the closure audit caught it.

**Fix:** `modules/05-assessment-lifecycle/src/service.ts`:
1. Added `getTenantById` to the `@assessiq/tenancy` import (line 41).
2. Added a single `const tenant = await getTenantById(tenantId)` call immediately before the `withTenant` scope — single DB hit shared across all invitees in the batch.
3. Derived `tenantName = tenant.name ?? tenant.slug` (fallback: slug if name is null/empty — slug is always non-empty per DB NOT NULL + check constraint; Zod `.min(1)` never fires on slug).
4. Replaced `tenantName: ""` with the real `tenantName` at the `sendInvitationEmail` call site.
5. Removed the stale placeholder comment block (lines 28-31) and the TODO comment at the call site.

Additionally, `modules/02-tenancy/package.json` was missing `@assessiq/audit-log: workspace:*` as a declared dependency (the import already existed in `service.ts` but was not declared; this caused a Vite resolution failure in the lifecycle test suite once `getTenantById` was imported for the first time from outside the tenancy module). Added declaration; `pnpm install` created the missing symlink. `modules/05-assessment-lifecycle/package.json` also needed the same declaration for the transitive chain.

**Tests added:**
- `modules/05-assessment-lifecycle/src/__tests__/lifecycle.test.ts` — Section 8 "Dev-email log": new test `"tenantName is fetched from DB — body contains real tenant name, NOT empty string"` asserts that the rendered email body contains `"AssessIQ (Tenant A)"` (the real tenant name) and not `"AssessIQ ()"`. Also updated the `template_id` filter in the section from `"invitation.assessment"` (old email-stub.ts format) to `"invitation_candidate"` (Phase 3 Handlebars template name) — the two pre-existing tests in this section were silently broken since Phase 3 G3.B shipped.
- `modules/13-notifications/src/__tests__/notifications.test.ts` — Section 5 "Legacy shims": new test `sendAssessmentInvitationEmail rejects tenantName:"" — regression for 05-lifecycle:749 cross-phase bug` asserts that passing `tenantName: ''` always throws (ZodError from `InvitationCandidateVarsSchema`).

**Prevention:**
1. **Cross-phase placeholder strings must fail fast.** Any `TODO: pass real X` comment at a call site where the downstream has a Zod schema is a latent 500. Prevention: the regression test added here ensures `tenantName: ""` always throws; future callers are caught at test time.
2. **Dependency declarations must be complete before shipping.** `02-tenancy/src/service.ts` imported `@assessiq/audit-log` at ship time (Phase 3 G3.A) but the package.json dependency was not added. Prevention: `pnpm typecheck` passes even with missing workspace declarations (TypeScript resolves across workspaces), but runtime Vite resolution fails. Add a CI step or convention: every new `import from "@assessiq/X"` in a module requires a corresponding `"@assessiq/X": "workspace:*"` in that module's `package.json`.
3. **Phase N regressions on Phase N-1 callers.** When Phase 3 G3.B shipped stricter Zod validation, existing Phase 1 callers were not audited. Prevention: SKILL.md files for notification modules should document caller contract requirements (e.g., "tenantName: non-empty string required, validated by Zod before send").

---

## 2026-05-03 — Frontend deploy stalled multi-hour: stale `Dockerfile.dockerignore` drift after G2.C shipped

**Symptom:** Phase 2 G2.C admin-dashboard frontend deploy session stalled for hours. Sonnet's deploy step rsync'd ~949 MB of source + `node_modules` from local Windows to VPS. After source landed, `docker compose -f infra/docker-compose.yml build assessiq-frontend` failed with `failed to compute cache key: failed to calculate checksum of ref ...: "/modules/06-attempt-engine": not found`. Verbose `--progress=plain` revealed 8 "not found" errors for modules 03/04/05/06/07/08/09/10. The directories existed on disk with correct permissions; `find . -xtype l` found no broken symlinks; standalone `docker buildx build .` from inside one of the failing module dirs succeeded. BuildKit cache prune didn't help; legacy `DOCKER_BUILDKIT=0` builder failed differently (apps/web/package.json not in context — confirming root `.dockerignore` is the wrong file for the frontend).

**Cause:** `infra/docker/assessiq-frontend/Dockerfile.dockerignore` (per-Dockerfile dockerignore — overrides root `.dockerignore` per BuildKit semantics) explicitly excluded `modules/{03-users, 04-question-bank, 05-assessment-lifecycle, 06-attempt-engine, 07-ai-grading, 08-rubric-engine, 09-scoring, 10-admin-dashboard}` because pre-G2.C the `apps/web` closure was only `@assessiq/{ui-system, candidate-ui, help-system, core, tenancy}`. G2.C `18fece2` added `apps/web → @assessiq/admin-dashboard`, which transitively pulls all 8 backend modules via type re-exports. Sonnet's `4807ba5 fix(frontend): update Dockerfile with admin-dashboard modules + skip tsc for docker build` correctly added 8 new `COPY modules/0X-...` lines to the Dockerfile but did NOT update the matching exclude list in `Dockerfile.dockerignore`. Result: Dockerfile says "COPY modules/10-admin-dashboard/" while dockerignore says "exclude modules/10-admin-dashboard"; BuildKit honors the exclude → directory invisible in the build context → "not found". Multi-hour rsync was incidental cover for the underlying drift bug.

**Fix:** `infra/docker/assessiq-frontend/Dockerfile.dockerignore` — comment out the 8 module excludes (modules/0[3-9]- + modules/10-admin-dashboard) with explanatory `# UNEXCLUDED for G2.C (admin-dashboard transitive closure):` prefix. Commit `e1e27bf fix(infra): unexclude G2.C modules from frontend Dockerfile.dockerignore`. Verified live: assessiq-frontend rebuilt in 32s (vs the multi-hour rsync grind), container healthy, `/admin/dashboard` + `/admin/attempts` + `/admin/login` all return 200 with the new JS bundle `index-CqLC_h7V.js`.

**Prevention:**

1. **Dockerfile / Dockerfile.dockerignore drift detection.** Add a CI lint at `tools/lint-dockerignore-vs-copy.ts` that for each `infra/docker/*/Dockerfile`: (a) parses every `COPY <path>` instruction, (b) parses the matching `Dockerfile.dockerignore`, (c) asserts that every `COPY` source path is NOT excluded by any pattern in the dockerignore. Run as part of `.github/workflows/ci.yml` deterministic gates. Catches the exact class of bug that bit today.
2. **Frontend transitive closure documentation.** Add a section to `infra/docker/assessiq-frontend/Dockerfile.dockerignore` header comment listing the current closure (currently 8 modules; will grow as Phase 4 adds embed-sdk). When the closure changes, both Dockerfile + Dockerignore + the comment must be updated together.
3. **Multi-hour rsync as a smell.** When deploy time exceeds ~5 minutes for a frontend rebuild, that's a sign the deploy architecture itself is wrong. See the next RCA entry for the architectural fix (git-clone-on-VPS vs rsync-from-local).

---

## 2026-05-03 — Architectural debt: `/srv/assessiq/` is not a git clone — every deploy is rsync-from-local

**Symptom:** Surfaced today during the G2.C deploy stall. Investigation revealed `/srv/assessiq/` on the production VPS is a flat copy of the repo (no `.git` directory; `git status` errors with `fatal: not a git repository`). All deploys since Phase 0 G0.A have been performed by rsync'ing the source tree (and accidentally `node_modules`, `apps/storybook/storybook-static`, etc.) from a developer's local machine to the VPS. Today's session burned hours rsyncing 949 MB of node_modules at ~30 KB/s per file before the docker build was even attempted.

**Cause:** Initial Phase 0 deploy procedure (`docs/06-deployment.md` § first-boot bootstrap) used `git archive | scp | tarball-extract` instead of `git clone`. The `.git` directory was never seeded on the VPS, so subsequent deploy sessions defaulted to rsync-from-local because `git pull` wasn't possible. This was viable when the repo was small (< 10 MB source) but degrades sharply as the workspace grows (~14 modules each with their own `node_modules`). Compounding: every parallel session that ran `pnpm install` on local Windows polluted its lockfile + node_modules tree, making the rsync surface even larger and triggering the lockfile-bleed RCA pattern (G1.A handoff `f0b5ad9` documented this).

**Fix:** Converted 2026-05-03 in a dedicated Sonnet/Copilot session. Steps taken:

1. VPS already had `~/.ssh/github_deploy` (ed25519) + `Host github.com-assessiq` stanza in `~/.ssh/config`, but the key was not registered on GitHub. Registered via `gh repo deploy-key add` from local machine — fingerprint `SHA256:HXZm4e6xgZjd1h++/CxJUpl8mcH4/raA1kg/Ci+peYk`, read-only access only.
2. Verified `ssh -T git@github.com-assessiq` → `Hi manishjnv/assessIQ! You've successfully authenticated`.
3. `mv /srv/assessiq /srv/assessiq.old` (atomic, instant, reversible).
4. `cd /srv && git clone git@github.com-assessiq:manishjnv/assessIQ.git assessiq` — clean clone at `0b35faa`.
5. `cp /srv/assessiq.old/.env /srv/assessiq/.env && chmod 0600` + `cp -r /srv/assessiq.old/secrets /srv/assessiq/secrets && chmod -R go-rwx` — `.env` (1060 bytes) + 3 secret files restored.
6. `docker compose -f infra/docker-compose.yml build assessiq-api` — built successfully from the git clone.
7. All 5 containers healthy (unchanged — they kept running throughout); `/api/health` → HTTP/2 200.
8. `/srv/assessiq.old/.delete-after.txt` pinned: "safe to remove after 2026-05-10".

**Prevention applied 2026-05-03:** Conversion shipped at `be161c5`. `/srv/assessiq` is now a git clone with deploy key fingerprint `SHA256:HXZm4e6xgZjd1h++/CxJUpl8mcH4/raA1kg/Ci+peYk`. Future deploys: `ssh assessiq-vps 'cd /srv/assessiq && git pull && docker compose -f infra/docker-compose.yml build <svc> && docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate <svc>'`. `/srv/assessiq.old` preserved until 2026-05-10 for rollback safety. See `docs/06-deployment.md` § "Deploy procedure (steady-state, post-2026-05-03)".

**Prevention:**

1. **Git-clone-on-VPS pattern is the deploy contract going forward.** Once landed, every Phase 4+ session uses `git pull && docker compose ... up -d --build`. No more rsync. No more multi-hour deploys. No more lockfile-bleed.
2. **`/srv/assessiq/.git` health check.** Add to the VPS additive-deploy enumeration step in `CLAUDE.md` rule #8: `test -d /srv/assessiq/.git || echo "WARNING: /srv/assessiq is not a git clone — see RCA 2026-05-03"`. If the warning fires, the next session is responsible for converting before any deploy.
3. **`docs/06-deployment.md` § Deploy procedure** must enumerate the standard 3-command flow + flag rsync as deprecated for any post-Phase-0 work.

---

## 2026-05-03 — Missing `@assessiq/audit-log` dep declarations: recurring pattern (3rd instance), prod restart-loop

**Symptom:** After 8fff574 added `@assessiq/audit-log` to apps/api/package.json (correct fix for ONE issue, partial), assessiq-api + assessiq-worker containers entered restart-loop on the next deploy with `ERR_MODULE_NOT_FOUND: Cannot find package '@assessiq/audit-log' imported from /app/modules/02-tenancy/src/service.ts`. /api/health → 502 Bad Gateway via Caddy.

**Cause:** `modules/02-tenancy/src/service.ts` and `modules/13-notifications/src/*` both import `@assessiq/audit-log` (the former added during G3.A 43c0e45 cross-module hook expansion, the latter during G3.B 13-notifications integration), but neither module's `package.json` declared the dep. pnpm's `--filter '@assessiq/api...'` selective install in the Docker builder honors only declared workspace deps; undeclared imports survive `pnpm typecheck` (TypeScript resolves across the workspace virtual store regardless of declarations) but FAIL at runtime when Node's ESM resolver looks for the package in the per-module `node_modules/`. Earlier `639cb22 revert(deps)` had legitimately reverted a stale dep declaration in modules/05-assessment-lifecycle (which doesn't import audit-log), but the rationale ("G3.A intentionally leaves audit-log undeclared") was overgeneralized — it correctly applied to 05-lifecycle but should NOT have inhibited the obviously-needed declarations in 02-tenancy + 13-notifications.

**Fix:** Commit `81da5db fix(deps): declare @assessiq/audit-log in 02-tenancy + 13-notifications` — added `"@assessiq/audit-log": "workspace:*"` to both `modules/02-tenancy/package.json` and `modules/13-notifications/package.json`; ran `pnpm install --no-frozen-lockfile` to regenerate the lockfile (4.5s; 6 lockfile lines added). Verified locally that `node_modules/@assessiq/audit-log` symlinks now resolve to `modules/14-audit-log/` in both modules. Redeployed via git-archive flow; assessiq-api + assessiq-worker rebuilt in 40s, both came up healthy on first try.

**Prevention:** This is the **third** documented instance of the "module imports `@assessiq/X` without declaring it in package.json" RCA pattern. Prior instances:

1. `73ad0b2` (Phase 1 closure fix) — modules/02-tenancy/src/service.ts already importing `@assessiq/audit-log` undeclared at G3.A ship time; surfaced when lifecycle test suite invoked the cross-module call path.
2. `8fff574` (G3.D session) — apps/api/package.json missing `@assessiq/audit-log`; surfaced when assessiq-api container tried to boot.
3. **This entry** — modules/02-tenancy + modules/13-notifications still missing after #1 was reverted by 639cb22 over-correction.

**Promote `tools/lint-cross-module-deps.ts` from "Phase 4+ tooling task" to immediate next-session priority.** The lint asserts every `import from "@assessiq/Y"` in a module has a corresponding `"@assessiq/Y": "workspace:*"` in that module's package.json. Run via `pnpm tsx tools/lint-cross-module-deps.ts` in the deterministic gates phase + as a CI step. Also catches the inverse class (declared deps that aren't imported — bloat). Today's incident lost ~3 hours across two sessions to a class of bug that the lint catches in 50ms. Worth a 30-min Sonnet session before any further deploys.

A second prevention: every revert commit must explicitly enumerate "what was reverted, what was NOT reverted, why." `639cb22`'s body said "premature dep declarations" (plural) but the diff was 1 line in 1 file (singular). The vague subject contributed to the over-correction interpretation that left the legitimate declarations missing.

**Prevention applied (2026-05-03):** `tools/lint-cross-module-deps.ts` shipped at `372838a`. The lint scans all `.ts`/`.tsx` source files, walks up to each file's nearest `package.json`, and asserts every `import from "@assessiq/X"` is declared in `dependencies` (or `devDependencies` for test/tools files). Wired into CI step 13 (self-test + repo scan) and documented in `.claude/hooks/precommit-gate.sh`. Also found and fixed a **4th hidden instance**: `tools/aiq-import-pack.ts` had been importing `@assessiq/core` + `@assessiq/tenancy` without root devDependency declarations since Phase 1 (`372838a` adds them). Scan result on main: **0 violations across 322 source files / 24 packages**.

## 2026-05-04 — POST /api/invitations/accept 500 `invalid input syntax for type uuid: ""`

**Symptom:** Every magic-link click (`POST /api/invitations/accept`) produced HTTP 500 at `2026-05-03T22:01:48Z` with PostgreSQL error `DatabaseError: invalid input syntax for type uuid: ""`. Error surface: `findInvitationByTokenHashSystem` ← `withSystemClient` ← `acceptInvitation` (`modules/03-users/src/invitations.ts:200`). All newly invited users were blocked from onboarding; the specific invitee `manishkumarjnvk@gmail.com` was manually unblocked via a direct DB `UPDATE users SET status = 'active'` at 2026-05-03T22:05Z.

**Cause:** `withSystemClient` in `modules/03-users/src/repository.ts` acquired a raw `pg.PoolClient` and called the query callback without starting a transaction. In production, `DATABASE_URL` connects as `assessiq_app` (RLS active, `NOINHERIT`). The `user_invitations` RLS policy evaluates `current_setting('app.current_tenant', true)::uuid`; with no `SET LOCAL` having run on a fresh/reused connection, `current_setting` returns `''` (the fail-open default when the second arg is `true`). Casting `''` to `::uuid` triggers the Postgres `INVALID_TEXT_REPRESENTATION` error. The fix was never triggered in the test environment because the testcontainer pool connects as the superuser (`BYPASSRLS` unconditionally).

**Fix (commit `30ba73d`):**
- `withSystemClient` now wraps its callback in `BEGIN` + `SET LOCAL ROLE assessiq_system` + `COMMIT/ROLLBACK`, mirroring the `withTenant` pattern. `assessiq_app` already holds `GRANT assessiq_system` from `0002_rls_helpers.sql`, so the elevation is permitted. `SET LOCAL` reverts on `COMMIT` so the pool connection is not polluted.
- Two regression tests added (`29/30` pass, was `27/28`): (1) asserts `SELECT current_user` inside `withSystemClient` equals `assessiq_system`; (2) calls `acceptInvitation` with no caller tenant context and asserts `result.user.tenant_id` equals the tenant from the invitation row.

**Prevention:**
- Any repository function that touches a table governed by a `current_setting('app.current_tenant', true)::uuid` RLS policy MUST either run inside `withTenant` (tenant-scoped) or inside a transaction with `SET LOCAL ROLE assessiq_system` (BYPASSRLS). A raw pool client without a transaction is safe ONLY on tables with no RLS, which is none of the production tables.
- The regression test that checks `current_user = assessiq_system` will fail immediately if the `SET LOCAL ROLE` line is removed or the `BEGIN` is removed, catching any future reversion.


## 2026-05-04 — POST /api/admin/questions 500 `null value in column `topic`"

**Symptom:** Creating a question from the admin UI returned HTTP 500 at `2026-05-03T22:02:14Z`. Postgres error: `null value in column 'topic' of relation 'questions' violates not-null constraint` (DatabaseError 23502). Admin could not add any questions to packs via the UI.

**Cause:** `POST /api/admin/questions` had no Fastify JSON-schema body validator. The React form did not include a `topic` field, so `req.body.topic` arrived as `undefined`. In `createQuestion()` in `modules/04-question-bank/src/service.ts`, the value was forwarded directly to the INSERT statement without a guard. `undefined` was serialized as NULL by `pg`, violating the NOT NULL constraint.

**Fix (commit `f390083`):**
- Added `QB_ERROR_CODES.INVALID_TOPIC` to `modules/04-question-bank/src/types.ts`.
- Added guard in `createQuestion()`: checks topic is non-empty string before proceeding.
- Added Fastify body schema to `POST /api/admin/questions`: requires `topic` (string, minLength 1, maxLength 200).
- Regression test added: `createQuestion with topic omitted throws ValidationError INVALID_TOPIC`. 61/61 tests pass.

**Prevention:**
- Every POST/PUT/PATCH route writing to Postgres MUST have a Fastify body schema covering all NOT NULL columns the UI might omit.
- DB constraint errors (23502) at the API layer are a symptom of missing route-layer validation. Phase 3 critique should bounce route handlers that modify tables without a body JSON schema declaration.

---

## 2026-05-04 — Admin cohort report page crashes on load (TypeError: API shape mismatch)

**Symptom:** Navigating to `/admin/reports/cohort/:assessmentId` threw `TypeError: Cannot convert undefined or null to object` in `Object.entries(report.band_distribution)`. Error surfaced in `frontend.log` at `2026-05-03T22:08:30Z`. The page was completely unusable.

**Cause:** `AdminCohortReport` in `modules/10-admin-dashboard/src/pages/cohort-report.tsx` was written against a stale API shape from an early design pass. It expected `{ band_distribution, candidates, assessment_name, total_candidates, median_band, pass_count, fail_count }`. The actual `GET /api/admin/reports/cohort/:assessmentId` (modules/09-scoring/src/routes.ts) returns `{ stats: { attempt_count, average_pct, p50, p75, p90, archetype_distribution } }`. `setReport(data)` stored the whole envelope; every access of `report.band_distribution` read `undefined`. `Object.entries(undefined)` threw immediately on render.

**Fix (commit `f160431`):**
- Replaced `CandidateRow`, `CohortReport` interfaces with `CohortStats`, `CohortResponse` matching actual API.
- Replaced `adminApi<CohortReport>(..)` / `setReport(data)` with `adminApi<CohortResponse>(..)` / `setStats(data.stats)`.
- Replaced band chart + leaderboard with: KPI cards (attempt count, avg%, p50/p75/p90), archetype bar chart, `ArchetypeRadar`.
- Removed anonymize toggle (no PII in stats payload).
- 17/17 admin-dashboard tests pass.

**Prevention:**
- Frontend component interfaces must be derived from the backend type export or from `docs/03-api-contract.md`, never assumed from early design docs.
- PRs shipping both a backend route and a frontend consumer must cross-check the response shape in the PR description.
- Phase 3 critique: when a frontend component uses `adminApi<T>()` with a locally-declared `T`, verify `T` matches the corresponding route handler's reply type.

## 2026-05-08 — AI question generator returned 'skill not found' on first generate click

**Symptom:** Admin opened pack detail, clicked ✦ Generate, drawer immediately showed error: `skill not found at /home/node/.claude/skills/generate-questions/SKILL.md`; no questions generated.

**Cause (layer 1):** `skill-sha.ts` resolves skill path via `os.homedir()` which returns `/home/node` inside the container. The `assessiq-api` compose volume block had no mount for skills, so `/home/node/.claude/skills/` did not exist in the container even though `prompts/skills/generate-questions/SKILL.md` was git-tracked on the host.

**Cause (layer 2):** A previous interim fix mounted `/root/.claude/skills` (a host OS directory outside the repo) instead of `prompts/skills/` from the repo. This meant skill changes required a manual `scp` step — the intended `git pull`-only deploy workflow was broken.

**Fix:** `infra/docker-compose.yml` — replaced `/root/.claude/skills:/home/node/.claude/skills:ro` with `../prompts/skills:/home/node/.claude/skills:ro` (relative to `infra/docker-compose.yml`) on both `assessiq-api` and `assessiq-worker`. Commit `0c3b856`. Container recreated; `docker exec assessiq-api ls /home/node/.claude/skills/` lists all 4 skills.

**Prevention:** Skill changes now deploy via `git pull` alone — no scp, no rebuild. Post-deploy smoke step documented in `docs/06-deployment.md` § Skill-deploy procedure: `docker exec assessiq-api ls /home/node/.claude/skills/` must list all expected skill directories. Consider a `tools/lint-skill-mount.ts` CI check that asserts every `prompts/skills/*/SKILL.md` has a corresponding compose bind-mount entry.

## 2026-05-09 — Assessment invitation emails silently dropped; email_log always empty

**Symptom:** Candidate (manishjnvk@gmail.com) invited to "Phase1 Closure Drill" never received an email. `assessment_invitations` row exists (status='pending'); `email_log` has 0 rows. Admin assessments list showed no invitation counts.

**Cause:** `modules/13-notifications/src/email/legacy-shims.ts:44` (`sendAssessmentInvitationEmail`) and `:24` (`sendInvitationEmail`) called `sendEmail()` without a `tenantId` argument. `modules/13-notifications/src/email/index.ts:118` guards the `email_log` INSERT behind `if (tenantId !== undefined && tenantId.length > 0)` — an intentional Phase 0 stub-only fallback. With `tenantId` absent the INSERT was skipped; the BullMQ job was enqueued with `tenantId: null`, so the worker had no tenant context to update `email_log` on delivery either. The call sites (`modules/05-assessment-lifecycle/src/service.ts:746` and `modules/03-users/src/invitations.ts:166`) had `tenantId` in scope but did not forward it through the email shim chain.

**Fix:**
- `modules/13-notifications/src/email-stub.ts`: added `tenantId?: string` to `SendInvitationEmailInput` and `SendAssessmentInvitationEmailInput`. Field documented: provided → email_log write; omitted → dev-emails.log fallback.
- `modules/13-notifications/src/email/legacy-shims.ts:24,44`: both shims now spread `tenantId` into the `sendEmail` options when present. Removed "email_log write is skipped" comments.
- `modules/05-assessment-lifecycle/src/email.ts`: added `tenantId?: string` to `SendAssessmentInvitationInput`; forwarded to `sendAssessmentInvitationEmail`.
- `modules/05-assessment-lifecycle/src/service.ts:746` (`inviteUsers`): added `tenantId` to the `sendInvitationEmail` call. `tenantId` was already the outer function parameter.
- `modules/03-users/src/invitations.ts:166` (`inviteUser`): added `tenantId` to the `sendInvitationEmail` call. `tenantId` was already the outer function parameter.

**Prevention:** Type-level — `tenantId` is now part of the shim input interfaces. Any new call site that omits it gets a TS hint (optional, not required, to preserve backward compatibility with dev environments without tenant context). Phase 3 critique: any `sendEmail`/`sendInvitationEmail`/`sendAssessmentInvitationEmail` call site inside a `withTenant` block that does not forward `tenantId` should be flagged as a potential silent-drop bug.

## 2026-05-09 — `email_log` row stays `queued` despite successful SMTP delivery

**Symptom:** Worker delivered an invitation email via SMTP (Gmail providerMessageId returned, `worker.job.finished status=succeeded`), but `email_log` row for the message stayed `status='queued'`, `attempts=0`, `sent_at=NULL` indefinitely. Admin observability blind for actual delivery state.

**Cause:** The post-send `email_log` UPDATE in the BullMQ email-send processor did not flow the canonical UUID through to the repo helper. `worker.job.finished` log line surfaced `result: { emailLogId: 36, status: 1 }` — `36` is the character-length of a UUIDv7, suggesting a `String#length` leak somewhere on the success path; the UPDATE then targeted a non-existent row id and silently affected 0 rows.

**Fix:** modules/13-notifications/src/email/index.ts (post-send path) + modules/13-notifications/src/repository.ts: tightened the worker→repo handoff so `email_log.id` flows through as the canonical UUID string. TypeScript signature on the repository helper rejects number-coerced ids at the type level so this exact regression cannot recur. Commit `c6d1992`.

**Prevention:** Type-level — `updateEmailLogStatus(id: string, …)` no longer accepts `number`. New `email-send-flow.test.ts` (12 cases) covers happy-path UPDATE + failure-path UPDATE + the type-level guard.

## 2026-05-10 — Forbidden field-name synonyms leaked through 3 SKILL.md revisions

**Symptom:** Sharded smokes (attempts `019e0d59`, `019e0da1`) inserted `ai_draft` questions whose `content` jsonb used SOC-authoring synonyms (`stem`, `explanation`, `correct_answer`, `log_snippet`, `answer_key`, `task`) instead of the canonical schema (`question`, `options`, `correct`, `rationale`, `log_excerpt`, `expected_findings`, `sample_solution`, `tables`). `score-candidate` reported `schemaValid: Required; Required;` for every inserted candidate; admin question-editor `QuestionContentView` couldn't render and fell back to JSON dump.

**Cause:** Prompt-level rules don't override Sonnet's strong priors on SOC content authoring. Three SKILL.md revisions (`2026-05-09b → c → d`) added increasingly explicit Tool-use policy + Source-citation contract + Question content shape (HARD RULE) sections with verbatim forbidden-synonym lists. Model continued to substitute synonyms anyway. The `submit_questions` MCP tool's Zod schema accepted any payload with a top-level `questions` array — content shape was schema-free at the MCP boundary.

**Fix (Stage 1.5e):** Move structural enforcement from prompt-level (advisory) to MCP-tool boundary (mechanical). `tools/assessiq-mcp/src/tools/submit-questions.ts` now uses a discriminated-union Zod schema with `.strict()` per-type content shapes. Any unknown key (every forbidden synonym) is rejected automatically. Validation rejection returns `isError: true` with a humanized Zod issue tree (max 1.5 KB) so the model gets feedback inside its `--max-turns` budget and can retry. Also: `modules/07-ai-grading/src/stream-json-parser.ts` `parseToolInput` switched from first-match to last-match so a model retry after rejection captures the corrected submission. Commits `3a7906d` + `bb17254`.

**Prevention:** The 5 SKILL.md HARD RULE sections stay as documentation but are no longer load-bearing — a Sonnet model emitting `stem` instead of `question` now sees an MCP tool error inside the same turn budget, not a silent schema-drift insert. New `tools/assessiq-mcp/src/__tests__/submit-questions.test.ts` covers 6 rejection cases per type. Verified live on attempt `019e0deb` (2026-05-09 18:06): inserted candidates have canonical `question/options/correct/rationale` content keys.

## 2026-05-10 — Citation HARD RULE wording leaked external IDs (mitre.t1003 etc.)

**Symptom:** Despite three SKILL.md revisions including a Source-citation contract + Forbidden citation patterns subsection, sharded-smoke candidates emitted `knowledge_base_source_ids: ["mitre.t1003", "T1558.003"]` — MITRE technique IDs instead of the verbatim `source.id` values from the prompt's `input.sources` array.

**Cause:** Same class of bug as the field-name synonym leak — prompt-level "verbatim copy" rules don't override the model's prior to cite by familiar identifiers. Compounded: the runtime's `sourceById.get(id)` lookup silently dropped unresolved IDs from `knowledgeBaseSources` (the displayed objects), but `knowledge_base_source_ids` (the raw model output) was preserved through to the DB. Citation correctness was unverifiable post-insert.

**Fix (Stage 1.5f):** Move citation enforcement from prompt-level to handler-level. `modules/07-ai-grading/src/handlers/admin-generate.ts` now runs `filterByCitation()` after `Promise.allSettled`: every `q.knowledge_base_source_ids` value is validated against `input.sources[].id`; questions with empty arrays OR any invalid id are dropped and counted in `citationDropped`. Migration 0043 added `generation_attempts.citation_dropped INTEGER`. All three generation paths (sharded, omnibus single-call, omnibus chunked) apply the same filter uniformly. Commit `13f6231`.

**Prevention:** The 5 SKILL.md citation HARD RULE wording stays as documentation but is no longer load-bearing — a model emitting `mitre.t1003` instead of the prompt-provided `id` now sees its question silently dropped pre-insert with a structured warn log including top-5 invalid IDs and a sample valid id. New `admin-generate-citation.test.ts` covers the 4-question scenario (valid / invalid / empty / mixed). Discovered side-effect: the eval/fixtures/L*-sources.json files used invented `src_l*_NNN` IDs while the real SOC KB uses `mitre.t*` IDs — fixtures realigned in commit `cd352c7`.

## 2026-05-10 — `generation_attempts.stderr_tail` always NULL on chunk-level failures

**Symptom:** `inspect-attempt --attempt-id 019e0deb --show-stderr` returned `(none)` despite 2 of 5 chunks (log_analysis + scenario) failing exit-1. Diagnostic surface for sharded chunk failures was effectively zero — the actual exit-1 reason existed in `claude-code-vps.ts` `claude.subprocess.summary` log lines (docker logs only) but never persisted to the DB row.

**Cause:** The runtime captures `stderrFull` (privacy-gated for generation skills) and attaches it to the thrown `AppError.details.stderrTail` on non-zero exit. The handler's sharded-branch `Promise.allSettled` iteration logged `err.message` on rejected entries but did NOT extract `details.stderrTail` from the error and pass it to `tryFinalizeAttempt`. The finalize path only populated `stderr_tail` on attempt-level failures (whole attempt threw before completing); chunk-level failures left the column NULL.

**Fix:** modules/07-ai-grading/src/handlers/admin-generate.ts now accumulates per-chunk stderr into `chunkStderrParts` with header markers (`--- chunk: <type> ---`), joins and slices the LAST 1024 bytes into `aggregatedStderrTail`, then passes it to `tryFinalizeAttempt` on both the partial-success path and (via a pre-throw call) the all-failed path. Chunk errors without `stderrTail` write `(none)` to the buffer entry instead of crashing. Privacy gate unchanged — only generation-skill stderr enters the buffer. Also: `claude-code-vps.ts` extended the timeout-path AppError to carry `stderrTail` when `isGenerationSkill === true`. Captured under runtime-baseline.json gap entry 2026-05-10.

**Prevention:** Post-fix, every chunk failure leaves diagnostic content in `generation_attempts.stderr_tail` keyed by per-chunk header markers. `inspect-attempt --show-stderr` surfaces it without SSH. Open known_gap on `log_analysis + scenario exit-1 mystery` is now diagnosable on the next sharded smoke.

## 2026-05-10 — Eval fixtures used invented IDs vs real SOC KB IDs

**Symptom:** Sharded smoke (attempt `019e0deb`) inserted candidates citing real SOC KB IDs (`mitre.t1059.001`, `mitre.t1003`, `mitre.t1558.003`). `score-candidate` flagged ALL of them as "unknown source ids" — reported 0/8 passed despite the candidates being structurally + citation-correct. Operator confusion: the gate said "regression" when the candidates were actually correct.

**Cause:** `modules/07-ai-grading/eval/fixtures/L{1,2,3}-sources.json` were authored from scratch in the Stage 1.5 goldens prompt with invented placeholder IDs (`src_l2_001`...`src_l2_008`). The real SOC KB in `modules/04-question-bank/src/knowledge-base/soc-l*.json` uses canonical MITRE-prefixed IDs. The runtime correctly resolved against the real KB; the comparator fixtures were the wrong reference.

**Fix:** Realigned `eval/fixtures/L1-sources.json` + `L2-sources.json` + `L3-sources.json` to mirror real entries from `soc-l1.json` + `soc-l2.json` + `soc-l3.json` verbatim. Updated all 75 goldens to cite real `mitre.t*` IDs from the matching level fixture. `pnpm eval:goldens-strict` continues to print 75/75 after realign. Commit `cd352c7`.

**Prevention:** Eval fixtures now mirror the canonical KB. Future SOC KB additions will require regenerating the eval fixtures in lock-step (no auto-sync; manual). Phase 3 critique: any fixture entry whose `id` doesn't appear in the level-matched `soc-l*.json` should be flagged.

## 2026-05-10 — Session-idle 60s heartbeat + blank-red attempt-detail on grade error

**Symptom:** Admin opened `/admin/attempts/<id>`, took >60s to read the question + answer (normal grading workflow), clicked Grade, got 409 `HEARTBEAT_STALE`. The SPA's error renderer at `attempt-detail.tsx:236-239` treated ANY error as page-level and replaced the entire page content with a giant red error block — admin couldn't see the question, couldn't refresh, couldn't recover without F5. Pre-existing 2× `lastSeenAt` TS errors on `modules/07-ai-grading/src/routes.ts:354,495` because the FastifyRequest session type augmentation was missing the `lastSeenAt` field.

**Cause:** Three coupled defects:
1. `modules/07-ai-grading/src/handlers/admin-grade.ts:163` (and admin-rerun.ts:153) checked `Date.now() - sessionLastActivity.getTime() > 60_000` — 60-second heartbeat too aggressive for any normal grading workflow that involves reading the question.
2. `modules/10-admin-dashboard/src/pages/attempt-detail.tsx:236` `if (error || !detail)` short-circuited to a blank-red full-page render. Treated transient grade errors with same severity as load failures.
3. Fastify session type augmentation didn't declare `lastSeenAt: string`, so `req.session!.lastSeenAt` typecheck-failed via project references for weeks.

**Fix:** admin-grade.ts + admin-rerun.ts: heartbeat 60_000 → 300_000 ms (5 min). attempt-detail.tsx: split fatal vs transient render — fatal block only when `!detail`; transient errors render an inline banner with Refresh + Dismiss buttons that doesn't replace the page content. apps/api session type augmentation declares `lastSeenAt: string`, closing the 2 pre-existing TS errors. Commit `cd352c7`.

**Prevention:** Type-level — `lastSeenAt` is now part of the augmented Fastify session shape. Phase 3 critique on any future SPA admin page: avoid `if (error || !detail)` blanket-fatal patterns; transient errors deserve banner-not-replacement UX.

## 2026-05-10 — `assessiq-api` healthcheck `wget: not found` (FailingStreak=1589)

**Symptom:** `docker inspect assessiq-api --format '{{.State.Health.Status}}'` reported "unhealthy" continuously. `docker ps` showed `(unhealthy)` next to the container despite `/api/health` returning 200 OK from the host. FailingStreak counter at 1589 — health probe had been failing for weeks. False alarm masking real health regressions.

**Cause:** `infra/docker-compose.yml` healthcheck was `["CMD", "wget", "-q", "--spider", "http://127.0.0.1:3000/api/health"]`. The api container is built FROM `node:22-slim` (Debian bookworm-slim) which does NOT include `wget` in its base image. The exec failed with `exec: "wget": executable file not found in $PATH`. The actual API service was always healthy; the probe was the only failing component.

**Fix:** Replaced the wget healthcheck with a Node fetch: `["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`. Node 22 ships built-in fetch. No new image layer, no wget install. After redeploy, `docker ps` shows `(healthy)`. Bundled into commit `cd352c7`.

**Prevention:** Any healthcheck command that depends on a binary not in the base image should be flagged at compose-validate time. The 127.0.0.1 (vs localhost) IPv6/IPv4 invariant from a prior RCA still applies — Fastify binds 0.0.0.0 (IPv4 only); localhost would hit ::1 first.

## 2026-05-15 — data-model doc-vs-schema drift (18 migrations without audit sweep)

**Symptom:** `docs/02-data-model.md` diverged from actual SQL migrations over 18 additive migrations (2026-05-01 → 2026-05-15): 1 undocumented table (`generation_attempts`), 1 phantom module-map entry (`archetypes`), 5 column/constraint gaps, 2 index gaps, 1 stale RLS policy listing.
**Cause:** Same-PR working agreement kept doc in sync at feature-ship time, but no cross-check sweep ever ran. Additive migrations (`ALTER TABLE … ADD COLUMN`) and late-phase policy rewrites (0075) were low-friction enough to slip past same-PR review.
**Fix:** `docs/02-data-model.md` patched in 3 commits (2026-05-15); all findings from file-shape audit against `modules/*/migrations/*.sql`.
**Prevention:** Propose a CI lint (`tools/lint-data-model-anchors.ts`) that greps `CREATE TABLE` names from all migration SQL files and verifies a matching `## <table-name>` or `### \`<table-name>\`` anchor exists in `docs/02-data-model.md`. Would have caught `generation_attempts` on the day it shipped.

## 2026-05-15 — Forward-looking risk note: single-VPS single-point-of-failure as the dominant incident class

**This is not a post-mortem — no incident has occurred. This entry records a structural risk
class surfaced by the 2026-05-15 operational maturity audit before it produces an incident.**

**Risk class:** The entire AssessIQ production system — Postgres, Redis, API, frontend, Caddy
(shared), and the AI grading runtime — runs on a single VPS (`srv1150121.hstgr.cloud`). Any
VPS-level event (hardware failure, Hostinger datacenter issue, OOM kill cascade, disk exhaustion,
botched `apt upgrade`, runaway `docker system prune` by a co-tenant) takes the system to zero
with no automated failover.

**Why this matters beyond "it's a single VPS":** Three compounding factors make the blast radius
larger than typical single-server deployments:

1. **Offsite backup target unverified (Critical gap 1.1).** The rclone remote `remote:assessiq-backups-prod`
   is a placeholder string in `docs/06-deployment.md`. Its actual configuration on the VPS has
   not been verified from the repo. If the VPS dies and the backup remote is not wired, complete
   data loss follows — tenant assessments, attempt history, audit logs, and encrypted secrets all
   gone. RPO = ∞, not the documented 24 h.

2. **Caddyfile not in repo (High gap 2.1).** Rebuilding on a new VPS requires recreating the
   Caddy config from `docs/06-deployment.md` prose and 3 RCA entries (bind-mount inode trap,
   `@api` matcher history, CF origin cert procedure). Each reconstruction step is a potential
   for a different config than what was live. This adds 30–60 min to any VPS-rebuild RTO.

3. **MASTER_KEY rotation impossible (Critical gap 6.1).** If the VPS is lost and rebuilt, the
   `ASSESSIQ_MASTER_KEY` must be carried forward — either from the `.env` backup or from memory.
   If the key is lost or incorrect, all TOTP secrets, embed signing keys, recovery codes, and
   webhook secrets become unreadable ciphertext. The 3-implementation duplication (crypto-util.ts,
   webhook-secret-service.ts, webhooks/crypto.ts) means a partial key loss could produce
   unpredictable partial outages that are hard to diagnose.

**Current documented RTO:** 1 h (from `docs/06-deployment.md`). This estimate has never been
timed against an actual restore drill (High gap 1.2). With the three compounding factors above,
the real RTO on total VPS loss is likely 3–6 h minimum and potentially data-loss-class if the
backup remote is not wired.

**Not an argument for premature infrastructure expansion.** The single-VPS architecture is
appropriate for Phase 1. The risk is not the architecture itself but the combination of:
(a) unverified backup remote, (b) Caddyfile not in repo, and (c) no restore drill ever run.
These are cheap to fix (1–2 sessions) and close the gap from "catastrophic on VPS loss" to
"recoverable in < 2 h from VPS loss."

**Prevention (already scoped):**
- MVP-1 (backup verification) + MVP-5 (Caddyfile in repo) + MVP-8 (restore drill) close 90 %
  of the blast radius at low implementation cost. See
  `docs/design/2026-05-15-operational-maturity-audit.md` § Minimum Viable Production.
- MVP-2 (MASTER_KEY dual-key fallback) ensures key rotation and key recovery are operational
  procedures, not outage events.

**Recurrence class:** This entry should be re-read any time a deploy procedure touches the VPS
backup cron, the rclone config, the Caddyfile, or the `ASSESSIQ_MASTER_KEY` env var. If all
four MVP items above are completed and a restore drill has been run, this entry can be closed
with a dated note in `docs/06-deployment.md` § DR.


## 2026-05-16 — Candidate answer-key leak in take-flow question content

**Symptom:** Admin spotted raw JSON question payloads on the admin attempt-detail page (cosmetic). Opus-directed read-only investigation found the deeper issue: `GET /api/me/attempts/:id` returned `question_versions.content` verbatim to candidates. For mcq this exposed `correct` (answer index) + `rationale`; log_analysis `expected_findings`/`sample_solution`; kql `expected_keywords`/`sample_solution`; scenario `steps[].expected`. Any candidate could open DevTools → Network and read the answers before submitting. Live integrity breach; every assessment/cert issued before this fix is suspect.

**Cause:** `modules/06-attempt-engine/src/repository.ts` `listFrozenQuestionsForAttempt` mapper returned `content: r.content` (the whole JSONB blob). The sibling `rubric` column was correctly excluded (not SELECTed), but answer-key fields embedded *inside* `content` had no field-level stripping. FE TypeScript comments said "not rendered to candidate" — a render-only guard, never a network guard.

**Fix:** Added `sanitizeContentForCandidate(type, content)` (modules/06-attempt-engine/src/repository.ts:314) — pure, allowlist-per-type, fail-closed; applied at the single candidate content chokepoint (the `.map()` in `listFrozenQuestionsForAttempt`). Allowlist keeps only candidate-safe fields; unknown type → `question` only. Prototype-pollution safe. Admin path (modules/07-ai-grading) deliberately untouched. Commit `0a1a7d4`, deployed 2026-05-16.

**Prevention:** 10 pure unit tests (`sanitize-content-for-candidate.test.ts`, no DB) assert presence AND absence of answer-key fields per type — regression guard. Recurrence class: any new question type, any change to `listFrozenQuestionsForAttempt`, or any new candidate endpoint returning question content MUST route through `sanitizeContentForCandidate` (or an equivalent allowlist). Fail-closed default means a new answer-key field is hidden by default, but a new *type* still needs its allowlist entry + a test case.

## 2026-05-16 — Cross-tenant FK partial-tag bypass (caught at review, never deployed)

**Symptom:** None in prod — caught by Opus security review of Slice 2 before deploy.

**Cause:** `modules/04-question-bank/src/service.ts` cross-tenant FK guard ran only `if (domainId !== undefined && categoryId !== undefined)`, but `domainId`/`categoryId` were threaded INDEPENDENTLY to `insertDrafts` (`input.domainId ?? null`, `input.categoryId ?? null`). Supplying exactly one → guard skipped → lone unvalidated FK persisted. Postgres FK validation bypasses RLS, so a tenant-A question could reference a tenant-B domain/category. Anti-pattern: guard predicate requires all params present, but params are consumed independently downstream.

**Fix:** `service.ts` — enforce both-or-neither BEFORE the existence check: `if ((domainId !== undefined) !== (categoryId !== undefined)) throw CROSS_TENANT_FK_REJECTED`. Then the existing composite tenant check. Commit `41012df`. 2 regression tests added (`generate-cross-tenant-guard.test.ts`: only-domain, only-category → rejected).

**Prevention:** Recurrence class — any guard whose predicate requires N params present while those params are used independently downstream. Whenever a security guard is conditional on a set of inputs, assert the inputs are an all-or-nothing set at the boundary, not just inside the all-present branch. The load-bearing-path Opus-review gate (per feedback-orchestration-sonnet-lead-opus-qa) is what caught this; keep it non-negotiable for FK/tenancy paths.

## 2026-05-19 — Confirmed live IP-spoof: origin reachable bypassing Cloudflare

**Symptom:** During Phase-0 grounding for the tracked "trustProxy/CF-IP" follow-up, a benign probe proved the vuln live: `curl --resolve assessiq.automateedge.cloud:443:72.61.227.64 -H 'CF-Connecting-IP: 203.0.113.99' .../api/health` → HTTP 200. The origin IP `:443` serves the real app directly, bypassing Cloudflare (DNS-proxy only; no Authenticated Origin Pulls / CF-IP firewall). Any attacker knowing the origin IP (in docs, DNS history, Shodan, Hostinger hostname) can spoof `cf-connecting-ip` on every request → defeats all per-IP rate limits (email-OTP/TOTP/candidate brute-force), IP-bound continuation/OTP tokens, and poisons audit IP attribution.

**Cause:** `apps/api/src/server.ts` `trustProxy:true` + 13 inlined `(req.headers['cf-connecting-ip'] as string|undefined) ?? req.ip` sites trusted the CF header with zero proof the request traversed Cloudflare. Pre-existing codebase-wide; the rate-limiter's own `extractClientIp` fail-closed-on-*missing*-header never triggered because the attacker *supplies* the header.

**Fix:** App-layer half (network-layer lockdown is a tracked separate session). New `modules/01-auth/src/client-ip.ts` `isOriginVerified()` (single-source predicate) + `extractClientIp()`; trust `cf-connecting-ip` only when a Cloudflare-injected `x-origin-verify` shared secret passes a SHA-256-digest constant-time compare. Rate-limit middleware (`extractRateLimitClientIp`) returns `null` on enforce+unverified → existing prod fail-closed `throw RateLimitError` (reject, not bucket). Env-gated `ORIGIN_TRUST_MODE` off→log→enforce (default `off` = byte-identical no-op); config `superRefine` refuses to boot on `enforce`+missing/short secret. Commit `3b2fe73`, deployed at `off` 2026-05-19 (no-op; enforcement pending operator Cloudflare Transform Rule + flip).

**Prevention:** 33 tests (client-ip 20, rate-limit-origin-verify 6, config +7 incl. the enforce-without-secret boot guard). Adversarial: Sonnet review (REVISE/7) + Opus adjudication — 1 CRITICAL + 3 MINOR fixed, 3 MAJOR by-design/not-regression/doc. Recurrence class: any new client-IP read MUST go through `extractClientIp`/`extractRateLimitClientIp` (grep guard: zero inline `cf-connecting-ip` in `apps/api/src`). **Open:** the secret's secrecy is the only barrier until the network-layer origin lockdown lands (tracked HIGH); `trustProxy:true` deliberately untouched (separate assessment).

## 2026-05-20 — IP-spoof vuln CLOSED: network-layer origin lockdown (Cloudflare AOP via Caddy mTLS)

**Symptom:** None in prod — completes the fix for the 2026-05-19 entry. The direct-to-origin spoof that returned HTTP 200 yesterday (`curl --resolve assessiq.automateedge.cloud:443:72.61.227.64 ...`) now returns curl HTTP `000` (TLS handshake rejected at Caddy).

**Cause:** The 2026-05-19 fix shipped the app-layer half (`x-origin-verify` shared secret, app rate-limit rejects unverified at the rate-limit layer). The remaining residual: the origin :443 still accepted ANY TLS handshake, so a direct-origin attacker could still REACH the app on non-rate-limited routes (e.g. `/api/health` — observability poisoning, audit IP poisoning, and any future un-rate-limited endpoint).

**Fix:** Cloudflare Authenticated Origin Pulls (zone-level) enabled in the dashboard + Caddy per-site `client_auth { mode require_and_verify; trusted_ca_cert_file /etc/caddy/ssl/cf-origin-pull-ca.pem }` on the AssessIQ block of `/opt/ti-platform/caddy/Caddyfile`. Phase 1 (`mode request`) was staged by a parallel session 2026-05-20 05:32 UTC (undocumented at the time); this session reviewed the staging, baselined neighbors, executed the Phase 2 canary flip to `require_and_verify` with auto-revert (UTC-stamped backup + `cat >` truncate-write per the bind-mount inode RCA 2026-04-30), and verified the 4-probe acceptance gate: CF→assessiq 200, direct-origin spoof 000, accessbridge.space 200, automateedge.cloud 200. Only the AssessIQ site block has `client_auth` — neighbors are unaffected by design. App-layer enforce (yesterday) stays in place as defense-in-depth.

**Prevention:** Recurrence class — any future Caddyfile edit on `/opt/ti-platform/caddy/Caddyfile` MUST follow the canary procedure in `docs/06-deployment.md § Authenticated Origin Pulls (AOP)`: backup → truncate-write (NEVER `mv`/`sed -i`/`cp` over the live file — bind-mount inode trap) → validate → reload → 4-probe acceptance → auto-revert on CF probe fail. The procedure is reusable for any neighbor edit too. Adversarial residual F4 (unverified login IP-binding degenerate in app-layer `enforce`) is now CLOSED: AOP rejects at TLS, so no unverified request can reach the application at all — the preconditions are gone. Operator caveat: if Cloudflare ever turns AOP off in the dashboard, every legit request fails at our Caddy handshake (loud failure, recoverable in seconds via the rollback). Caddy v2.11.1 logged a `trusted_ca_cert_file → trust_pool` deprecation; tracked as cosmetic Caddyfile hygiene.

## 2026-05-22 — Admin attempt-detail rendered question + answer as raw JSON (cosmetic half of the 2026-05-16 entry)

**Symptom:** On `/admin/attempts/:id` every question and the candidate's answer rendered as a raw pretty-printed JSON blob — `{ "correct": 0, "options": [...], "question": "...", "rationale": "..." }` with braces/brackets/quotes visible, like a code sample. Re-reported with a fresh screenshot 2026-05-22 (attempt `019e0dd8`, wipro-soc).

**Cause:** `modules/10-admin-dashboard/src/pages/attempt-detail.tsx` had a local `QuestionContent`/`AnswerContent` pair (lines 77–94) doing `typeof x === "string" ? x : JSON.stringify(x, null, 2)`. Question `content` and every candidate-answer shape are objects, so the JSON branch always fired. The repo already shipped a type-aware `QuestionContentView` (used by the question editor) but this page never imported it. The cosmetic fix was deliberately deferred when the deeper candidate answer-key leak was found 2026-05-16 ("no fixing now") — this entry closes the deferral.

**Fix:** `attempt-detail.tsx` — render the question via the shared `QuestionContentView` (`type` + `content`), and add a read-only `AttemptAnswerView` that maps each canonical answer shape to readable text (mcq selected letter + option + ✓/✗ vs key; subjective response; kql query; log_analysis findings + explanation; scenario per-step). Empty → "No answer submitted."; unrecognised shapes → a readable message, never braces. Presentation-only; admin-only route (`RequireSession role="admin"`); no server / classifier / auth change.

**Prevention:** 53 admin-dashboard tests pass incl. `attempt-detail-error.test.tsx › renders question content after initial load`. Recurrence class: any admin surface displaying question content or candidate answers MUST use `QuestionContentView` / `AttemptAnswerView` (or an equivalent typed renderer) — never `JSON.stringify` a payload into JSX. Documented in `docs/08-ui-system.md § Question & answer content renderers (never raw JSON)`. The candidate-facing leak half was closed separately (RCA 2026-05-16 `sanitizeContentForCandidate`); answer-key display here is admin-only by design. Pre-existing unrelated `noUncheckedIndexedAccess` tsc errors in `AdminShell.tsx:183/186` were observed during verify but left out of scope (on `main` before this change).

## 2026-05-22 — 429 RATE_LIMITED (scope=ip) on the admin login screen

**Symptom:** A legit admin saw `{"error":{"code":"RATE_LIMITED","message":"rate limit exceeded for scope=ip","details":{"retryAfterSeconds":12,"scope":"ip"}}}` on the **live assessiq.in login screen** while logged out — exactly the lockout the role-aware rate-limit redesign was supposed to make impossible for legit admins.

**Cause:** The "never locks out legit admins" cap (`RATE_LIMIT_IP_VERIFIED_ADMIN`=5000/min) applies ONLY to a session with role∈{admin,reviewer,super_admin} **AND** `totpVerified===true`. The pre-auth login bootstrap is **anonymous**: every load/return to a protected `/admin/*` route fires `GET /api/auth/whoami` (`apps/web/src/lib/RequireSession.tsx`→`useSession`→`fetchWhoami`), which runs through the main Redis limiter in the **anon tier = `RATE_LIMIT_IP_ANON`=30/min** (`modules/01-auth/src/middleware/rate-limit.ts` `resolveIpBucketMax`). 30/min/IP is exhausted by an admin reloading the live login page (or several users behind one NAT), and the 429 lands on the login screen — *before* the user can reach the MFA step that lifts them to the 5000/min tier. Secondary amplifier: `fetchWhoami` cached only the 401 case and re-threw 429 without caching, so every subsequent protected-route mount re-fired whoami → another 429 (stickier lockout). Not a loop (in-flight+module cache + `replace` nav) and **not** `/api/_log` (separate 600/min limiter, different error shape).

**Fix:** (1) `modules/00-core/src/config.ts:149` (+ `.env.example`) — `RATE_LIMIT_IP_ANON` default 30→**120**. Purely a DoS knob; credential brute-force protection is the SEPARATE `RATE_LIMIT_CREDENTIAL` bucket (20/min, `credentialEndpoint:true` on all OTP/TOTP/magic-link/SSO routes), unaffected. Commit `ad88f72`, deployed (assessiq-api image rebuild + `--force-recreate`; not pinned in prod `.env`, so the code default applies). (2) `apps/web/src/lib/session.ts` `fetchWhoami` — back off on 429: honour `details.retryAfterSeconds` (clamped to [1,300]s), suppress re-fire until it elapses, do NOT poison `cached`; `force=true` (post-login) bypasses. **Frontend half is staged but NOT yet committed** — it shares `session.ts` with in-flight Phase D login-banner WIP, so it ships with that commit (or standalone on request). Backend fix alone fully resolves the reported 429.

**Prevention:** `00-core` config tests (32) + `01-auth` rate-limit-tiered (15) green; adversarial **Sonnet review = ACCEPT** (credential-bucket independence confirmed in code; CF + origin-verify `enforce` front the origin, so 120/min/IP is a sound unauthenticated ceiling; frontend backoff can't mask revocation since revocation is 401 not 429, and the server enforces every request regardless). **Behavioral verify on live assessiq.in:** an anon request returned header `x-ratelimit-limit: 120`, and a 35-request anon burst returned **35×401, 0×429** (would have 429'd at the old cap of 30). Recurrence class: the anon tier gates the ENTIRE pre-auth surface — any future per-IP tightening must keep headroom for the login bootstrap's whoami probes, and credential protection must stay on the separate credential bucket, never the anon IP cap.

## 2026-05-24 — Super-admin tenant lifecycle actions dead-ended on stale MFA

**Symptom:** On `/admin/platform`, if a super-admin's last TOTP was older than 15 minutes, clicking Suspend / Archive / Resume / Unarchive in a tenant's `Manage ▾` menu returned `401 "fresh totp required"` and the UI rendered it as a raw red error Chip with no way to re-verify in place — the operator was stuck (unlike the Create-company modal, which already had an MFA step-up recovery). The `api.ts` doc comment even promised "401 → MfaStepUp" behaviour the lifecycle UI never implemented.

**Cause:** `modules/10-admin-dashboard/src/pages/platform.tsx`. The four lifecycle routes are gated server-side by `superAdminFreshMfa` (`freshMfaWithinMinutes:15` — `apps/api/src/routes/admin-super.ts`), which throws `AuthnError("fresh totp required")` → 401 (`modules/01-auth/src/middleware/require-auth.ts:88-95`). `CreateCompanyForm` recovered from that 401 with an in-place `MfaStepUp`; `LifecycleConfirmModal` had no such sub-state, and the page-level `handleLifecycleConfirm` swallowed the 401 into a generic error Chip and closed the modal.

**Fix:** `platform.tsx` — (1) `MfaStepUp` gained an optional `confirmLabel` prop (default `"Verify & create"`, so Create-company/Edit-admin are byte-for-byte unchanged); (2) `LifecycleConfirmModal` got a `confirm|mfa` sub-state — on a fresh-totp 401 it swaps to `MfaStepUp` (lifecycle-specific prompt + `Verify & {verb}` button) and, on `onVerified`, retries the original action with the typed reason preserved; (3) `handleLifecycleConfirm` re-throws ONLY the fresh-totp 401 (narrow `status===401 && /fresh totp/i` match) without closing the modal. No server/gate change: enforcement stays 100% server-side. **The code shipped in commit `234c196` (PR #5, bundled with the editable-company-name feature) and is LIVE — the served `assessiq-frontend` bundle on prod contains the lifecycle signature.** This doc + RCA entry are the same-fix follow-up the code PR omitted (a parallel session shipped the code without docs); a separate isolated-worktree session independently produced the identical patch but did not push it once the duplicate was detected.

**Prevention:** Module `tsc --noEmit` clean; web SPA build clean. Adversarial gate: **Sonnet takeover = ACCEPT** on all 5 vectors (bypass / error-misrouting / loop / injection / React footguns) — codex:rescue companion stalled at "Starting Codex Resume.", so the sanctioned Sonnet-takeover fallback was used (a separate codex run also returned ACCEPT). Two low-severity NON-security notes from review, left as-is: (a) if the server's `"fresh totp required"` string ever changes, the client silently degrades to the page-level error display (UX, not security); (b) `void handleConfirm()` on retry is fire-and-forget (benign dev-only unmounted-setState warning). Recurrence class: any super-admin mutating modal gated by `superAdminFreshMfa` MUST wire the `MfaStepUp` recovery — Create-company, Edit-admin, and now lifecycle all do. Documented in `docs/08-ui-system.md § Super-admin Platform page`. **Process note:** this fix was implemented concurrently by two sessions on the shared working tree, causing repeated loss of uncommitted edits via branch-checkouts — see the `parallel-session-shared-working-tree` hazard; prefer an isolated worktree when another session may be active. **Test gap CLOSED (follow-up commit):** `apps/api/src/__tests__/routes/admin-super.test.ts` now collects again — the `@assessiq/auth` mock was switched to spread `vi.importActual` and override ONLY the gating middleware (robust against vitest's strict named-import rule, which the prior full-replacement mock kept tripping as new auth exports like `CANDIDATE_LOGIN_TOKEN_TTL_SEC` landed), and the missing `@assessiq/tenancy` (`assertTenantActive`, `createTenant`, `activateTenant`, `resume/archive/unarchiveTenant`) + `@assessiq/users` (`cancelInvitation`, `sweepUserSessions`) mock exports were added. Ten new tests cover the four lifecycle endpoints — happy path, idempotent no-op skips the session sweep, suspend/archive sweep while resume/unarchive don't, 403/401 role gates, reason validation (control-chars + >500 chars), and a 409 wrong-direction transition. **18/18 pass.** The fresh-MFA gate itself is NOT exercised by these route tests (the header seam bypasses it) — it stays covered by 01-auth unit tests. **Also fixed (cosmetic, Finding 3):** the suspend confirm modal previously showed `(${count} users)` counting only admins+reviewers — reworded to name all affected categories (admins, reviewers, candidates), since the backend sweep signs out candidates too; the exact revoked count is shown in the post-action toast.

## 2026-05-24 — Archive does nothing on draft question packs (silent no-op)

**Symptom:** On `/admin/question-bank`, clicking `⋯ → Archive…` on a pack (e.g. the empty auto-created `dom-threat-intelligence` / `dom-phishing` / `dom-soc` packs in the screenshot) and confirming the dialog did nothing — the pack stayed in the list, no error, no toast. Archive looked broken.

**Cause:** Two compounding defects.
(1) **Backend over-restriction** — `modules/04-question-bank/src/service.ts` `archivePack` threw `409 ConflictError PACK_NOT_PUBLISHED` for any pack whose status wasn't exactly `published` (line ~493). New packs default to `status='draft'` (`repository.ts:372`; `findOrCreatePackForDomain` inserts with no status → DB default `'draft'`, `service.ts:1323`), so the auto-managed `dom-*` packs and any freshly-created/empty pack could never be archived — yet `routes.ts` documents archive (`status='archived'`) as the **only** soft-delete path in Phase 1 (no hard DELETE). The exact packs an admin would want to clean up were unreachable.
(2) **Frontend swallowed the error** — `modules/10-admin-dashboard/src/pages/question-bank.tsx` `handleArchivePack` caught the 409 into a bare `console.warn`, so the admin saw no feedback at all. (`handleImportSet` had the same swallow.)

**Fix:** (a) `service.ts` `archivePack` — guard changed from `status !== 'published'` to `status === 'archived'`: both **draft and published** packs are now archivable; only an already-archived pack is rejected, with a new `PACK_ALREADY_ARCHIVED` code (`types.ts` `QB_ERROR_CODES`). The assessment-reference gate (`PACK_HAS_ASSESSMENTS`) is unchanged and still runs. (b) `question-bank.tsx` — added an `actionError` state + dismissible `role="alert"` banner; `handleArchivePack` and `handleImportSet` now surface the API message instead of swallowing it. Soft-delete via `status='archived'` remains the only delete path — no hard DELETE introduced.

**Prevention:** `04-question-bank` full suite green (62/62) incl. two updated/added cases: "archivePack on a draft pack succeeds; status becomes archived" (was previously asserting the buggy `PACK_NOT_PUBLISHED` rejection) and "archivePack on an already-archived pack throws PACK_ALREADY_ARCHIVED". Both touched modules `tsc --noEmit` clean. Not security/auth/classifier (module 04, non-load-bearing) — no codex:rescue gate required; multi-tenancy unchanged (`withTenant` + RLS, audit row still written via `auditInTx`). API contract updated (`docs/03-api-contract.md` `POST /admin/packs/:id/archive` row). Recurrence class: any admin row-action that can return a 4xx MUST surface it to the operator — a swallowed `console.warn` reads as "the button does nothing".

## 2026-05-25 — Question Bank: row ⋯ menu invisible + search box did nothing

**Symptom:** On `/admin/question-bank`, (a) clicking the row **⋯** menu showed no dropdown — the Archive action was unreachable; (b) typing in the **Search packs…** box and submitting returned the full list unchanged. (Operator also asked for pack levels in the list and a saner default filter.)

**Cause:**
(1) **⋯ menu clipped.** `RowOverflowMenu` in `modules/10-admin-dashboard/src/pages/question-bank.tsx` rendered its dropdown with `position:absolute` inside the packs table card, which uses `overflow:hidden` for rounded corners. The absolutely-positioned panel was clipped to the card's box and never painted. This is the *exact* failure the Platform page already documented and solved for `ManageMenu` (08-ui-system § Super-admin Platform page) — the lesson hadn't been applied to this menu.
(2) **Search dropped at two layers.** The frontend sent `?search=…`, but `GET /admin/packs` (`modules/04-question-bank/src/routes.ts`) parsed only `domain`/`status` and never read `search` (contrast `GET /admin/questions`, which does). Even had it passed through, `listPacks` in `repository.ts` built its WHERE from `domain`/`status` only — no `search` branch. So the term was silently discarded both places. (The Users page search was unaffected — it's wired end-to-end via `modules/03-users`.)

**Fix:**
(1) `RowOverflowMenu` now renders via `createPortal` to `document.body`, anchored with `getBoundingClientRect` + `position:fixed`, `zIndex:1000`, closing on outside-click / Esc / scroll / resize — mirroring `ManageMenu`.
(2) Route now reads `q["search"]` into `ListPacksInput.search`; `listPacks` adds a parameterised case-insensitive substring condition on **name OR slug** (`lower(col) LIKE '%'||lower($n)||'%'`, the `%…%` built in SQL so LIKE metachars can't inject). Also added `level_count` (correlated subquery on `levels`) to the list row + a **Levels** column, and defaulted the list filter to **Published** (one-time ref-guarded mount redirect to `?status=published`; clicking **All** still clears it).

**Prevention:** `04-question-bank` suite **64/64** (added "search matches name OR slug, case-insensitive substring" and "returns level_count"). Both modules `tsc --noEmit` clean. API contract + UI doc updated same-PR. Recurrence classes: (a) **any row popover inside an `overflow:hidden` table MUST portal out** — absolute positioning will be clipped; (b) **a new list filter must be threaded through ALL THREE layers** (frontend query → route parse → repository WHERE) — a param that compiles but is ignored at the route/repo silently no-ops with no error.

## 2026-05-25 — Certificate PDF download 500'd since launch (Chromium never installed in api image)

**Symptom:** `GET /api/certificates/:credentialId/pdf` returned `500 {"code":"INTERNAL"}`; admin/candidate could never download a cert PDF (PDF Downloads counter stuck at 0 for every cert). Reported via the credential AIQ-2026-05-DTJC72.

**Cause:** `modules/18-certification/src/pdf/render.ts` renders the cert by launching **headless Chromium** via `playwright-core` at `executablePath: '/usr/bin/chromium'`. `playwright-core` was a declared dep (installed), but the **`assessiq-api` Docker image never installed a Chromium binary** — `infra/docker/assessiq-api/Dockerfile`'s runtime apt layer installed only `ca-certificates`. So `chromium.launch()` threw `Failed to launch chromium because executable doesn't exist at /usr/bin/chromium` (api log, render.ts:35). The PDF path had been broken since the feature shipped (no successful download ever).

**Fix:** Added `chromium` + `fonts-liberation` to the api Dockerfile runtime apt install (commit `28aa615`). Debian's `chromium` package installs to `/usr/bin/chromium` (matching render.ts's default) and pulls its shared-lib deps; `fonts-liberation` covers the template's Helvetica/Georgia fallbacks. Additive to AssessIQ's own image only (no neighbor impact; VPS had 63 GB free). Also added a **Download PDF** button to the admin Certificate Details drawer (`certificates.tsx`) — it previously showed a download *count* but no link.

**Prevention / verification:** Verified behaviorally (not just "binary present") with an in-container smoke — `playwright-core` launched `/usr/bin/chromium` with `--no-sandbox` and produced an 8,550-byte PDF (`PDF_OK_BYTES=8550`). Recurrence class: any feature that shells out to a browser/binary must have that binary installed in the deploy image AND a behavioral smoke (launch+render), not just the npm dep — the dep being present hid the missing-binary gap. (Unit tests mock `renderCertificatePdf`, so they never caught it.)

## 2026-05-25 — Opening any assessment showed a blank page (conditional React hook)

**Symptom:** Clicking any row on /admin/assessments opened a blank `/admin/assessments/:id` — no chrome, no error UI. The list and the API were fine.

**Cause:** `modules/10-admin-dashboard/src/pages/assessment-detail.tsx` — the sortable-tables change added `const sortedInvitations = React.useMemo(...)` AFTER the component's early returns (`if (loading) return …`, `if (error || !assessment) return …`). On first render the component returns in the loading branch and never calls the `useMemo`; when the fetch resolves it re-renders past the guards and DOES call it → the hook count changes between renders → React throws "rendered more hooks than during the previous render" and unmounts to a blank page. Classic Rules-of-Hooks violation (a hook called conditionally). No client error reached the server logs, and `tsc` can't catch it (it's a runtime ordering rule). Detail pages are uniquely exposed because they early-return on loading/error; the list pages render loading inline so their sort `useMemo` is unconditional.

**Fix:** Hoisted the `sortedInvitations` `useMemo` above the early returns so it runs on every render (same order). Audited the other four sort-`useMemo` pages (attempts, dashboard, question-bank, assessments) — all place the hook before their single return / render loading inline, so none were affected.

**Prevention:** Rule for this codebase — **all hooks (incl. `useMemo`/`useCallback`) go at the top of the component, before any early `return`.** A detail page that early-returns on loading/error must keep every hook above those guards. Consider enabling `eslint-plugin-react-hooks` `rules-of-hooks` in CI (it flags exactly this) — it would have caught it at lint time.

## 2026-05-26 — Cloned licensed-set assessment unpublishable: "Question pool too small: 0 < 5"

**Symptom:** On `/admin/assessments/:id` for "app sec 25 may" (tenant WIPRO-SOC, draft) the page showed **"Question pool too small: 0 < 5"** and could not be published. The licensed "Application Security" set advertised "3 levels · 5 q" in the create picker and the super-admin had authored 5 questions in it — yet the tenant's assessment saw an empty pool. A second reported symptom — "questions are at L1 but it shows level 3" — was a **misread of the picker's "3 levels" label**; the assessment was correctly bound to L1 (position 1, label "L1"), and the source questions live only at L1. There was no level misbinding.

**Cause:** The licensed-set clone (`clonePackToTenant`, `modules/04-question-bank/src/clone.ts`) and re-sync (`buildTaxonomyResolver`) remap each source question's `(domain, category)` into the target tenant **by slug**, and SILENTLY SKIP (`skippedCount++; continue;`, clone.ts ~363 / resolver `{ok:false}`) any question whose tag has no slug match in the target tenant. The 5 platform questions are all tagged `domain=application-security, category=waf`. WIPRO-SOC had the `application-security` **domain** but **no `waf` category** — because platform **domains** propagate to the whole fleet (`platform-domains.ts createPlatformDomain`) and are seeded at tenant creation (`seed.ts seedFromPlatform`), but platform **categories created after a tenant already exists never propagate**. So all 5 questions were dropped: the clone materialized with **0 questions** (clone audit `tenant.pack_cloned`: `{"skipped_count":5,"question_count":0}`), every level (L1/L2/L3) empty, and the publish pre-flight `countActiveQuestionsForLevel(pack, L1)` returned `0 < 5`.

**Fix:**
(1) **Durable (code, commit `78853a4`):** new `provisionPlatformTaxonomyForQuestions()` in clone.ts — before a clone/resync copies questions, it provisions exactly the platform domains/categories those questions reference into the target tenant (idempotent, `source='platform'`, copying full attrs), mirroring `seed.ts seedFromPlatform`. Called from BOTH `clonePackToTenant` and `buildTaxonomyResolver`, so clone **and** re-sync (incl. `publishPack` auto-sync) self-heal. The existing slug remap + skip stays as the final safety net. Guard (mirrors seed.ts): a platform category is only attached under a target domain that is itself `source='platform'`; a tenant-LOCAL domain sharing the slug is never given platform categories. Sonnet adversarial review (tenancy = security-adjacent) caught a race where the `ON CONFLICT` re-SELECT hardcoded `source='platform'` in-memory (could attach a platform category under a raced-in tenant-local domain) → fixed to read the true `source` and degrade gracefully if the row vanished. Deployed: assessiq-api rebuilt+recreated (additive `--no-deps`), `/api/health` 200.
(2) **Immediate data repair (prod SQL, in-place, no deletion):** provisioned the `waf` category into WIPRO-SOC (copying platform attrs) and copied the 5 active L1 source questions into the existing empty clone's L1 with `version=2` + a `question_versions{v1}` snapshot each (matching the clone invariant `version = MAX(qv)+1`) and taxonomy remapped to the WIPRO `application-security`/`waf` ids. Verified: clone L1 = 5 active, all selectable via the attempt-pool INNER JOIN (`max_qv=1`), pool 5/5. WIPRO-SOC has an **active** `application-security` domain entitlement, so publish passes both gates (the orange "may not be entitled" banner is a conservative client-side heads-up, not the actual server gate).

**Prevention:** The clone/resync self-heal closes the silent data-loss path for ALL future clones (any tenant, any platform-only category). Recurrence class: **a slug-based cross-tenant remap that "skips on miss" silently loses data when two tenants' taxonomies diverge** — the only breadcrumb was the `skipped_count` audit field. **Open follow-ups (not blockers):** (a) mirror `createPlatformDomain`'s fleet propagation for **categories** (or add `createPlatformCategory`) so a tenant's dropdowns reflect platform categories without waiting for a clone; (b) surface `skipped_count` on the clone/re-sync result to the admin instead of burying it in the audit log; (c) the clone does not copy difficulty tags (`cognitive_level`/`nice_task_id`/`difficulty_params`) — pre-existing, separate.
