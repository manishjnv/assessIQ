# Session — 2026-05-01 (G0.C-4 Pre-Flight — `01-auth` decisions)

**Headline:** Window 4 (`01-auth`) ambiguity-pin shipped — appended `## Decisions captured (2026-05-01)` to `modules/01-auth/SKILL.md` covering 10 buckets (Redis session schema, recovery codes, TOTP, account lockout, embed JWT, API key, rate limits, magic link, tenant-context handoff, 03-users boundary), each with **decision · source · rationale**; scaffolded `modules/01-auth/migrations/` with `.gitkeep` + `README.md` listing six schema sketches (`010_oauth_identities` → `015_api_keys`) citing `02-data-model.md` line ranges; resolved two real spec drifts (TOTP secret 32 → 20 bytes per RFC 4226 §4 since `04-AUTH:102` was correct and the plan was wrong; denormalized `tenant_id` onto `oauth_identities` / `user_credentials` / `totp_recovery_codes` for linter compliance + defense-in-depth); added `role` and `last_totp_at` columns to `sessions` so role-discriminated middleware + step-up MFA don't need a users-table JOIN on every request; explicit `&algorithm=SHA1` on the otpauth URI in `04-AUTH:104`. Pure documentation pass — no runtime code, no deploy, no codex:rescue trigger (this session is pre-flight, not implementation).

**Commits:**

- HEAD on push — `docs(auth): pin 01-auth decisions before window 4` (run `git log` for the SHA)

**Tests:** skipped — pure documentation diff, no source changed. Phase 2 gates: secrets-scan clean (no AWS/OpenAI/etc. signatures, no hardcoded literals); no un-tagged markers introduced (the SKILL.md addendum mentions a `TODO(audit)` convention for Window 4 to follow, not a literal occurrence). The 103/103 vitest suite from G0.B-2 remains green and was not re-run since no source code changed. Pre-existing markdownlint warnings in `02-data-model.md` and `04-auth-flows.md` (table-column-style, fenced-code-language, blanks-around-fences) predate this PR — not in newly-added content; deferred to a future docs-cleanup pass.

**Next:** Window 4 (G0.C Session 4) — `01-auth` implementation. Reads `modules/01-auth/SKILL.md` (especially the new addendum), `modules/01-auth/migrations/README.md`, the updated `docs/02-data-model.md:88–183` block, and `docs/04-auth-flows.md`. Implementation contract is now frozen across 10 buckets — codex:rescue review focuses on logic (auth flows, signature verification, token lifecycle) rather than schema or parameter drift. Optional Window 5 (`03-users` + admin login UI) opens in parallel once Window 4's `sessions.create` primitive stabilizes — the cross-module contract (`03-users.acceptInvitation` calls `01-auth.sessions.create`) is pinned in addendum decision #10.

**Open questions:**

- Embed-JWT replay-cache size under load: at the 600/min/tenant rate limit and a 600s max token lifetime, worst-case cache footprint is ~360k keys per tenant. Acceptable on Phase 0's single Redis but should be revisited if a tenant ever sustains embed traffic at that rate. Phase 2 monitoring concern, not a Window-4 blocker.
- `oauth_identities.UNIQUE (provider, subject)` stays globally unique by product decision (cross-tenant contractors must use separate Google accounts). If a future enterprise customer challenges this, the resolution is composite key `UNIQUE (tenant_id, provider, subject)` plus a tenant-picker UI on login. Deferred until challenged.
- Account-lockout audit emits to a 14-audit-log stub today; the actual `audit_log` writes happen when 14-audit-log lands in Phase 3. Window 4 should `// TODO(audit)`-mark the emission site so a future grep finds it (the relaxed marker regex from G0.B-2's CI explicitly accepts the tagged form).
- `getTenantBySlug` still throws (G0.B-2 carry-forward). Window 4's Google SSO callback needs slug → tenant lookup before tenant context exists. The three options inherited from G0.B-2 (ship a minimal `withSystemRole`, introspect via `oauth_identities.tenant_id`, or hardcode bootstrap admin's tenant) are not pre-resolved here because the choice depends on whether 14-audit-log lands in Phase 3 or earlier — Window 4 picks at implementation time and documents in its own SKILL.md addendum.

---

## Agent utilization

- **Opus:** orchestrator and sole implementer this session. Phase 0 warm-start parallel reads of 10 files (PROJECT_BRAIN, 01-architecture-overview, SESSION_STATE, RCA_LOG, PHASE_0_KICKOFF, 01-auth/SKILL, 04-auth-flows, 03-api-contract, 02-data-model, 03-users/SKILL); plan synthesis with two flagged decisions presented for user approval (TOTP 20-byte vs 32-byte, `tenant_id` denormalization on three auth tables); after `go`, drafted directly: the 10-bucket SKILL.md addendum (~370 lines), `migrations/README.md` (six schema sketches with citations), `docs/02-data-model.md` schema-note block + four targeted column edits (`oauth_identities`, `user_credentials`, `totp_recovery_codes`, `sessions`), and the otpauth `algorithm=SHA1` clarification on `04-auth-flows.md:104`. Work was judgment-bound (drift adjudication against RFC 4226, schema decisions affecting RLS, dependency-graph reasoning for the cross-module boundary) — Sonnet handoff would have lost cache warmth and added nothing on a docs-only pass.
- **Sonnet:** n/a — no mechanical-implements work; the deliverables were judgment-only.
- **Haiku:** n/a — no bulk read sweeps; the 10-file Phase 0 burst by Opus covered all sources, and citation accuracy needed Opus's judgment about which line ranges were authoritative.
- **codex:rescue:** n/a — pre-flight session, no implementation code, nothing in a load-bearing path. First mandatory invocation lands in Window 4 once the `01-auth` migrations + middleware + JWT verify diff exists.

---

## Files shipped (5)

- `modules/01-auth/SKILL.md` — appended `## Decisions captured (2026-05-01)` (10 buckets + schema-deviations addendum).
- `modules/01-auth/migrations/.gitkeep` — directory placeholder.
- `modules/01-auth/migrations/README.md` — 6 migration filenames with one-paragraph schema sketches and `02-data-model.md` line citations + acceptance criteria for Window 4.
- `docs/02-data-model.md` — schema-note block above `## Users & auth` explaining `tenant_id` denormalization decision (5-part: what / why / considered / not-included / impact); `tenant_id` columns added to `oauth_identities` / `user_credentials` / `totp_recovery_codes`; `role` + `last_totp_at` columns added to `sessions`; partial index on `totp_recovery_codes (user_id) WHERE used_at IS NULL`.
- `docs/04-auth-flows.md` — explicit `&algorithm=SHA1` on the otpauth URI (line 104), parenthetical noting authenticator-app default ambiguity if omitted.

No deployment this session — pure docs. VPS untouched (still G0.B-2's state: `assessiq-postgres` healthy, both roles + rotated passwords in `/srv/assessiq/secrets/`, no Caddy edit yet).

---

## Previous-session pointers (G0.B-2 archived in git history)

The G0.B-2 (`02-tenancy`) handoff at commit `7923492` is preserved in `git show 7923492:docs/SESSION_STATE.md`. Key state for Window 4:

- `assessiq-postgres` (Postgres 16 Alpine) running on VPS at `/srv/assessiq/`, container is `assessiq-postgres`, network `assessiq-net`, volume `assessiq_assessiq_pgdata`.
- Three migrations applied: `0001_tenants.sql`, `0002_rls_helpers.sql`, `0003_tenants_rls.sql`. `tenants` and `tenant_settings` live with `rowsecurity = t` and 4 policies total (2 per table).
- Three Postgres roles in place: `assessiq` (postgres superuser, bootstrap-only), `assessiq_app` (login, no BYPASSRLS — production runtime), `assessiq_system` (login, BYPASSRLS — for ops/migrations only). 30-char random passwords generated and persisted at `/srv/assessiq/secrets/assessiq_{app,system}_password.txt` (chmod 0600).
- **Window 4 setup hooks:** (a) `assessiq-api` runtime `DATABASE_URL` must use `assessiq_app` with the rotated password (NOT the bootstrap superuser); until that env var lands on the VPS, the API container fails Zod config-load; (b) Window 4 has 6 migrations and is the right point to ship `tools/migrate.ts` with a `_migrations` tracking table — until then, deploy applies via `docker compose exec -T assessiq-postgres psql -U assessiq -d assessiq < <files>`.
- Tools/CI in place: `tools/lint-rls-policies.ts` rejects any `CREATE TABLE … tenant_id …` lacking both `tenant_isolation` USING and `tenant_isolation_insert` WITH CHECK; the CI marker regex was relaxed in G0.B-2 to accept tagged forms — `TODO(audit)`, `TODO(phase-1)` and similar (lowercase letters / digits / hyphens inside the parens).
- `getTenantBySlug` deferred (throws). The Phase 1 fix is `withSystemRole(fn)` helper, gated by `14-audit-log` arriving — but Window 4 needs slug → tenant lookup before tenant context for the Google SSO callback. See "Open questions" above for the three options.

The G0.B-3 (`17-ui-system`) handoff at commit `f21ac4d` is preserved in `git show f21ac4d:docs/SESSION_STATE.md`. Phase 0 G0.B is fully complete; G0.C is unblocked.
